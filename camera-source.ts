import type { RingCamera } from 'ring-client-api'
import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import type { SrtpOptions } from '@homebridge/camera-utils'
import {
  generateSrtpOptions,
  ReturnAudioTranscoder,
  RtpSplitter,
} from '@homebridge/camera-utils'
import type {
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  CameraStreamingDelegate,
  RecordingPacket,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge'
import {
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  H264Level,
  H264Profile,
  SRTPCryptoSuites,
} from 'homebridge'
import { logDebug, logError, logInfo } from 'ring-client-api/util'
import { debounceTime, delay, take } from 'rxjs/operators'
import { interval, merge, of, Subject } from 'rxjs'
import { readFile } from 'fs'
import { promisify } from 'util'
import { getFfmpegPath } from 'ring-client-api/ffmpeg'
import {
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpPacket,
  SrtpSession,
  SrtcpSession,
} from 'werift'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import path from 'node:path'

const __dirname = new URL('.', import.meta.url).pathname,
  mediaDirectory = path.join(__dirname.replace(/\/lib\/?$/, ''), 'media'),
  readFileAsync = promisify(readFile),
  cameraOfflinePath = path.join(mediaDirectory, 'camera-offline.jpg'),
  snapshotsBlockedPath = path.join(mediaDirectory, 'snapshots-blocked.jpg')

function getDurationSeconds(start: number) {
  return (Date.now() - start) / 1000
}

function getSessionConfig(srtpOptions: SrtpOptions) {
  return {
    keys: {
      localMasterKey: srtpOptions.srtpKey,
      localMasterSalt: srtpOptions.srtpSalt,
      remoteMasterKey: srtpOptions.srtpKey,
      remoteMasterSalt: srtpOptions.srtpSalt,
    },
    profile: 1,
  }
}

function* parseMp4Boxes(data: Buffer): Generator<{ type: string; box: Buffer }> {
  let offset = 0

  while (offset + 8 <= data.length) {
    const shortLength = data.readUInt32BE(offset)
    let boxLength = shortLength
    let headerLength = 8

    if (shortLength === 1) {
      if (offset + 16 > data.length) {
        break
      }

      boxLength = Number(data.readBigUInt64BE(offset + 8))
      headerLength = 16
    } else if (shortLength === 0) {
      break
    }

    if (boxLength < headerLength || offset + boxLength > data.length) {
      break
    }

    const box = data.subarray(offset, offset + boxLength),
      type = box.subarray(4, 8).toString('ascii')

    yield { type, box }

    offset += boxLength
  }
}

class StreamingSessionWrapper {
  audioSsrc = hap.CameraController.generateSynchronisationSource()
  videoSsrc = hap.CameraController.generateSynchronisationSource()
  audioSrtp = generateSrtpOptions()
  videoSrtp = generateSrtpOptions()
  audioSplitter = new RtpSplitter()
  videoSplitter = new RtpSplitter()
  transcodedAudioSplitter = new RtpSplitter()

  public streamingSession
  public prepareStreamRequest
  public ringCamera
  public start

  constructor(
    streamingSession: StreamingSession,
    prepareStreamRequest: PrepareStreamRequest,
    ringCamera: RingCamera,
    start: number,
  ) {
    this.streamingSession = streamingSession
    this.prepareStreamRequest = prepareStreamRequest
    this.ringCamera = ringCamera
    this.start = start

    const {
        targetAddress,
        video: { port: videoPort },
      } = prepareStreamRequest,
      // used to encrypt rtcp to HomeKit for keepalive
      videoSrtcpSession = new SrtcpSession(getSessionConfig(this.videoSrtp)),
      onReturnPacketReceived = new Subject()

    // Watch return packets to detect a dead stream from the HomeKit side
    // This can happen if the user force-quits the Home app
    this.videoSplitter.addMessageHandler(() => {
      // return packet from HomeKit
      onReturnPacketReceived.next(null)
      return null
    })
    this.audioSplitter.addMessageHandler(() => {
      // return packet from HomeKit
      onReturnPacketReceived.next(null)
      return null
    })
    streamingSession.addSubscriptions(
      merge(of(true).pipe(delay(15000)), onReturnPacketReceived)
        .pipe(debounceTime(5000))
        .subscribe(() => {
          logInfo(
            `Live stream for ${
              this.ringCamera.name
            } appears to be inactive. (${getDurationSeconds(start)}s)`,
          )
          streamingSession.stop()
        }),
    )

    // Periodically send a blank RTCP packet to the HomeKit video port
    // Without this, HomeKit assumes the stream is dead after 30 second and sends a stop request
    streamingSession.addSubscriptions(
      interval(500).subscribe(() => {
        const senderInfo = new RtcpSenderInfo({
            ntpTimestamp: BigInt(0),
            packetCount: 0,
            octetCount: 0,
            rtpTimestamp: 0,
          }),
          senderReport = new RtcpSrPacket({
            ssrc: this.videoSsrc,
            senderInfo: senderInfo,
          }),
          message = videoSrtcpSession.encrypt(senderReport.serialize())

        this.videoSplitter
          .send(message, {
            port: videoPort,
            address: targetAddress,
          })
          .catch(logError)
      }),
    )
  }

  private listenForAudioPackets(startStreamRequest: StartStreamRequest) {
    const {
        targetAddress,
        audio: { port: audioPort },
      } = this.prepareStreamRequest,
      timestampIncrement =
        startStreamRequest.audio.sample_rate *
        startStreamRequest.audio.packet_time,
      audioSrtpSession = new SrtpSession(getSessionConfig(this.audioSrtp))

    let runningTimestamp: number

    this.transcodedAudioSplitter.addMessageHandler(({ message }) => {
      const rtp: RtpPacket | undefined = RtpPacket.deSerialize(message)

      // For some reason HAP uses RFC 3550 timestamps instead of following RTP Paylod
      // Format for Opus Speech and Audio Codec from RFC 7587 like everyone else.
      // This calculates and replaces the timestamps before forwarding to Homekit.
      if (!runningTimestamp) {
        runningTimestamp = rtp.header.timestamp
      }

      rtp.header.timestamp = runningTimestamp % 0xffffffff
      runningTimestamp += timestampIncrement

      // encrypt the packet
      const encryptedPacket = audioSrtpSession.encrypt(rtp.payload, rtp.header)

      // send the encrypted packet to HomeKit
      this.audioSplitter
        .send(encryptedPacket, {
          port: audioPort,
          address: targetAddress,
        })
        .catch(logError)

      return null
    })
  }

  async activate(request: StartStreamRequest) {
    let sentVideo = false
    const {
        targetAddress,
        video: { port: videoPort },
      } = this.prepareStreamRequest,
      // use to encrypt Ring video to HomeKit
      videoSrtpSession = new SrtpSession(getSessionConfig(this.videoSrtp))

    // Set up packet forwarding for video stream
    this.streamingSession.addSubscriptions(
      this.streamingSession.onVideoRtp.subscribe(({ header, payload }) => {
        header.ssrc = this.videoSsrc
        header.payloadType = request.video.pt

        const encryptedPacket = videoSrtpSession.encrypt(payload, header)

        if (!sentVideo) {
          sentVideo = true
          logInfo(
            `Received stream data from ${
              this.ringCamera.name
            } (${getDurationSeconds(this.start)}s)`,
          )
        }

        this.videoSplitter
          .send(encryptedPacket, {
            port: videoPort,
            address: targetAddress,
          })
          .catch(logError)
      }),
    )

    const transcodingPromise = this.streamingSession.startTranscoding({
      input: ['-vn'],
      audio: [
        '-acodec',
        'libopus',
        '-application',
        'lowdelay',
        '-frame_duration',
        request.audio.packet_time.toString(),
        '-flags',
        '+global_header',
        '-ar',
        `${request.audio.sample_rate}k`,
        '-b:a',
        `${request.audio.max_bit_rate}k`,
        '-bufsize',
        `${request.audio.max_bit_rate * 4}k`,
        '-ac',
        `${request.audio.channel}`,
        '-payload_type',
        request.audio.pt,
        '-ssrc',
        this.audioSsrc,
        '-f',
        'rtp',
        `rtp://127.0.0.1:${await this.transcodedAudioSplitter.portPromise}`,
      ],
      video: false,
      output: [],
    })

    let cameraSpeakerActive = false
    // used to send return audio from HomeKit to Ring
    const returnAudioTranscodedSplitter = new RtpSplitter(({ message }) => {
        if (!cameraSpeakerActive) {
          cameraSpeakerActive = true
          this.streamingSession.activateCameraSpeaker()
        }

        // deserialize and send to Ring - werift will handle encryption and other header params
        try {
          const rtp: RtpPacket | undefined = RtpPacket.deSerialize(message)
          this.streamingSession.sendAudioPacket(rtp)
        } catch {
          // deSerialize will sometimes fail, but the errors can be ignored
        }

        return null
      }),
      returnAudioTranscoder = new ReturnAudioTranscoder({
        prepareStreamRequest: this.prepareStreamRequest,
        startStreamRequest: request,
        incomingAudioOptions: {
          ssrc: this.audioSsrc,
          rtcpPort: 0, // we don't care about rtcp for incoming audio
        },
        outputArgs: [
          '-acodec',
          'libopus',
          '-application',
          'lowdelay',
          '-frame_duration',
          '60',
          '-flags',
          '+global_header',
          '-ar',
          '48k',
          '-b:a',
          '48k',
          '-bufsize',
          '192k',
          '-ac',
          '2',
          '-f',
          'rtp',
          `rtp://127.0.0.1:${await returnAudioTranscodedSplitter.portPromise}`,
        ],
        ffmpegPath: getFfmpegPath(),
        logger: {
          info: logDebug,
          error: logError,
        },
        logLabel: `Return Audio (${this.ringCamera.name})`,
        returnAudioSplitter: this.audioSplitter,
      })

    this.streamingSession.onCallEnded.pipe(take(1)).subscribe(() => {
      returnAudioTranscoder.stop()
      returnAudioTranscodedSplitter.close()
    })

    this.listenForAudioPackets(request)
    await returnAudioTranscoder.start()
    await transcodingPromise
  }

  stop() {
    this.audioSplitter.close()
    this.transcodedAudioSplitter.close()
    this.videoSplitter.close()
    this.streamingSession.stop()
  }
}

export class CameraSource
  implements CameraStreamingDelegate, CameraRecordingDelegate
{
  public controller
  private sessions: { [sessionKey: string]: StreamingSessionWrapper } = {}
  private cachedSnapshot?: Buffer
  private ringCamera

  private recordingActive = false
  private recordingConfiguration?: CameraRecordingConfiguration
  private closedRecordingStreams = new Set<number>()
  private recordingWaiters = new Map<number, () => void>()
  private activeRecordingSessions = new Map<number, () => void>()

  constructor(ringCamera: RingCamera, config: RingPlatformConfig) {
    this.ringCamera = ringCamera

    const enableHksv =
      config.enableHksv && !(config.disableHksvOnBattery && ringCamera.hasBattery)

    const controllerOptions: any = {
      cameraStreamCount: enableHksv ? 1 : 10,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1920, 1024, 30],
            [1280, 720, 30],
            [1024, 768, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 360, 30],
            [480, 270, 30],
            [320, 240, 30],
            [320, 240, 15], // Apple Watch requires this configuration
            [320, 180, 30],
          ],
          codec: {
            profiles: [H264Profile.BASELINE],
            levels: [H264Level.LEVEL3_1],
          },
        },
        audio: {
          codecs: [
            {
              type: AudioStreamingCodecType.OPUS,
              // required by watch
              samplerate: AudioStreamingSamplerate.KHZ_8,
            },
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_16,
            },
            {
              type: AudioStreamingCodecType.OPUS,
              samplerate: AudioStreamingSamplerate.KHZ_24,
            },
          ],
        },
      },
    }

    if (enableHksv) {
      const prebufferLength = Math.max(config.hksvPrebufferLengthMs ?? 4000, 4000),
        fragmentLength = config.hksvFragmentLengthMs ?? 4000

      controllerOptions.recording = {
        delegate: this,
        options: {
          prebufferLength,
          overrideEventTriggerOptions: [
            (hap as any).EventTriggerOption.MOTION,
            (hap as any).EventTriggerOption.DOORBELL,
          ],
          mediaContainerConfiguration: {
            type: (hap as any).MediaContainerType.FRAGMENTED_MP4,
            fragmentLength,
          },
          video: {
            type: (hap as any).VideoCodecType.H264,
            parameters: {
              profiles: [
                H264Profile.BASELINE,
                H264Profile.MAIN,
                H264Profile.HIGH,
              ],
              levels: [
                H264Level.LEVEL3_1,
                H264Level.LEVEL3_2,
                H264Level.LEVEL4_0,
              ],
            },
            resolutions: [
              [1920, 1080, 30],
              [1280, 720, 30],
              [640, 480, 30],
              [320, 240, 15],
            ],
          },
          audio: {
            codecs: {
              type: (hap as any).AudioRecordingCodecType.AAC_LC,
              samplerate: [
                (hap as any).AudioRecordingSamplerate.KHZ_16,
                (hap as any).AudioRecordingSamplerate.KHZ_24,
                (hap as any).AudioRecordingSamplerate.KHZ_32,
                (hap as any).AudioRecordingSamplerate.KHZ_48,
              ],
              audioChannels: 1,
              bitrateMode: (hap as any).AudioBitrate.VARIABLE,
            },
          },
        },
      }

      logInfo(`HKSV services enabled for ${this.ringCamera.name}`)
    }

    this.controller = new hap.CameraController(controllerOptions)
  }

  private previousLoadSnapshotPromise?: Promise<any>
  async loadSnapshot(imageUuid?: string) {
    // cache a promise of the snapshot load
    // This prevents multiple concurrent requests for snapshot from pilling up and creating lots of logs
    if (this.previousLoadSnapshotPromise) {
      return this.previousLoadSnapshotPromise
    }

    this.previousLoadSnapshotPromise = this.loadAndCacheSnapshot(imageUuid)

    try {
      await this.previousLoadSnapshotPromise
    } catch {
      // ignore errors
    } finally {
      // clear so another request can be made
      this.previousLoadSnapshotPromise = undefined
    }
  }

  fn = 1
  private async loadAndCacheSnapshot(imageUuid?: string) {
    const start = Date.now()
    logDebug(
      `Loading new snapshot into cache for ${this.ringCamera.name}${
        imageUuid ? ' by uuid' : ''
      }`,
    )

    try {
      const previousSnapshot = this.cachedSnapshot,
        newSnapshot = await this.ringCamera.getSnapshot({ uuid: imageUuid })
      this.cachedSnapshot = newSnapshot

      if (previousSnapshot !== newSnapshot) {
        // Keep the snapshots in cache 2 minutes longer than their lifetime
        // This allows users on LTE with wired camera to get snapshots each 60 second pull even though the cached snapshot is out of date
        setTimeout(
          () => {
            if (this.cachedSnapshot === newSnapshot) {
              this.cachedSnapshot = undefined
            }
          },
          this.ringCamera.snapshotLifeTime + 2 * 60 * 1000,
        )
      }

      logDebug(
        `Snapshot cached for ${this.ringCamera.name}${
          imageUuid ? ' by uuid' : ''
        } (${getDurationSeconds(start)}s)`,
      )
    } catch (e: any) {
      this.cachedSnapshot = undefined
      logDebug(
        `Failed to cache snapshot for ${
          this.ringCamera.name
        } (${getDurationSeconds(
          start,
        )}s), The camera currently reports that it is ${
          this.ringCamera.isOffline ? 'offline' : 'online'
        }`,
      )

      // log additioanl snapshot error message if one is present
      if (e.message.includes('Snapshot')) {
        logDebug(e.message)
      }
    }
  }

  private getCurrentSnapshot() {
    if (this.ringCamera.isOffline) {
      return readFileAsync(cameraOfflinePath)
    }

    if (this.ringCamera.snapshotsAreBlocked) {
      return readFileAsync(snapshotsBlockedPath)
    }

    logDebug(
      `${
        this.cachedSnapshot ? 'Used cached snapshot' : 'No snapshot cached'
      } for ${this.ringCamera.name}`,
    )

    if (!this.ringCamera.hasSnapshotWithinLifetime) {
      this.loadSnapshot().catch(logError)
    }

    // may or may not have a snapshot cached
    return this.cachedSnapshot
  }

  async handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback,
  ) {
    try {
      const snapshot = await this.getCurrentSnapshot()

      if (!snapshot) {
        // return an error to prevent "empty image buffer" warnings
        return callback(new Error('No Snapshot Cached'))
      }

      // Not currently resizing the image.
      // HomeKit does a good job of resizing and doesn't seem to care if it's not right
      callback(undefined, snapshot)
    } catch (e: any) {
      logError(`Error fetching snapshot for ${this.ringCamera.name}`)
      logError(e)
      callback(e)
    }
  }

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ) {
    const start = Date.now()
    logInfo(`Preparing Live Stream for ${this.ringCamera.name}`)

    try {
      const liveCall = await this.ringCamera.startLiveCall(),
        session = new StreamingSessionWrapper(
          liveCall,
          request,
          this.ringCamera,
          start,
        )

      this.sessions[request.sessionID] = session

      logInfo(
        `Stream Prepared for ${this.ringCamera.name} (${getDurationSeconds(
          start,
        )}s)`,
      )

      callback(undefined, {
        audio: {
          port: await session.audioSplitter.portPromise,
          ssrc: session.audioSsrc,
          srtp_key: session.audioSrtp.srtpKey,
          srtp_salt: session.audioSrtp.srtpSalt,
        },
        video: {
          port: await session.videoSplitter.portPromise,
          ssrc: session.videoSsrc,
          srtp_key: session.videoSrtp.srtpKey,
          srtp_salt: session.videoSrtp.srtpSalt,
        },
      })
    } catch (e: any) {
      logError(
        `Failed to prepare stream for ${
          this.ringCamera.name
        } (${getDurationSeconds(start)}s)`,
      )
      logError(e)
      callback(e)
    }
  }

  async handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback,
  ) {
    const sessionID = request.sessionID,
      session = this.sessions[sessionID],
      requestType = request.type

    if (!session) {
      callback(new Error('Cannot find session for stream ' + sessionID))
      return
    }

    if (requestType === 'start') {
      logInfo(
        `Activating stream for ${this.ringCamera.name} (${getDurationSeconds(
          session.start,
        )}s)`,
      )
      try {
        await session.activate(request)
      } catch (e) {
        logError('Failed to activate stream')
        logError(e)
        callback(new Error('Failed to activate stream'))

        return
      }
      logInfo(
        `Streaming active for ${this.ringCamera.name} (${getDurationSeconds(
          session.start,
        )}s)`,
      )
    } else if (requestType === 'stop') {
      logInfo(`Stopped Live Stream for ${this.ringCamera.name}`)
      session.stop()
      delete this.sessions[sessionID]
    }

    callback()
  }

  updateRecordingActive(active: boolean) {
    this.recordingActive = active
    logInfo(`HKSV recording ${active ? 'enabled' : 'disabled'} for ${this.ringCamera.name}`)
  }

  updateRecordingConfiguration(
    configuration: CameraRecordingConfiguration | undefined,
  ) {
    this.recordingConfiguration = configuration
    this.closedRecordingStreams.clear()
    this.recordingWaiters.forEach((wake) => wake())
    this.recordingWaiters.clear()

    if (configuration) {
      logInfo(
        `HKSV recording configuration updated for ${this.ringCamera.name} (fragmentLength=${configuration.mediaContainerConfiguration.fragmentLength}ms, prebuffer=${configuration.prebufferLength}ms)`,
      )
      return
    }

    logInfo(`HKSV recording configuration cleared for ${this.ringCamera.name}`)
  }

  async *handleRecordingStreamRequest(
    streamId: number,
  ): AsyncGenerator<RecordingPacket> {
    logInfo(`HKSV recording stream requested for ${this.ringCamera.name} (streamId=${streamId})`)

    if (!this.recordingActive || !this.recordingConfiguration) {
      logDebug(
        `HKSV recording request ignored for ${this.ringCamera.name} because recording is not active or configured`,
      )
      return
    }

    this.closedRecordingStreams.delete(streamId)

    const packetQueue: RecordingPacket[] = []
    let waitForPacket: (() => void) | undefined,
      pendingData = Buffer.alloc(0),
      initBoxes: Buffer[] = [],
      initSent = false,
      fragmentBoxes: Buffer[] = [],
      closed = false

    const fragmentLengthMs =
      this.recordingConfiguration.mediaContainerConfiguration.fragmentLength

    const wake = () => {
        waitForPacket?.()
        waitForPacket = undefined
      },
      enqueuePacket = (packet: RecordingPacket) => {
        packetQueue.push(packet)
        wake()
      },
      closeSession = () => {
        if (closed) {
          return
        }

        closed = true
        this.closedRecordingStreams.add(streamId)
        this.activeRecordingSessions.delete(streamId)
        wake()
      }

    this.recordingWaiters.set(streamId, closeSession)
    this.activeRecordingSessions.set(streamId, closeSession)

    let liveCall: StreamingSession | undefined
  let keyFrameTimer: ReturnType<typeof setInterval> | undefined

    try {
      liveCall = await this.ringCamera.startLiveCall()

      liveCall.onCallEnded.pipe(take(1)).subscribe(() => {
        closeSession()
      })

      await liveCall.startTranscoding({
        video: [
          '-vcodec',
          'libx264',
          '-preset',
          'veryfast',
          '-tune',
          'zerolatency',
          '-pix_fmt',
          'yuv420p',
          '-profile:v',
          'baseline',
          '-level:v',
          '3.1',
          '-g',
          '30',
          '-keyint_min',
          '30',
          '-sc_threshold',
          '0',
        ],
        output: [
          '-movflags',
          'frag_keyframe+empty_moov+default_base_moof',
          '-frag_duration',
          `${fragmentLengthMs * 1000}`,
          '-fflags',
          '+genpts',
          '-reset_timestamps',
          '1',
          '-f',
          'mp4',
          'pipe:1',
        ],
        stdoutCallback: (data) => {
          if (closed) {
            return
          }

          pendingData = Buffer.concat([pendingData, data])

          let consumed = 0

          for (const { type, box } of parseMp4Boxes(pendingData)) {
            consumed += box.length

            if (!initSent) {
              initBoxes.push(box)

              if (type === 'moov') {
                enqueuePacket({
                  data: Buffer.concat(initBoxes),
                  isLast: false,
                })
                initBoxes = []
                initSent = true
              }

              continue
            }

            if (type === 'styp') {
              fragmentBoxes = [box]
              continue
            }

            if (type === 'moof') {
              fragmentBoxes = fragmentBoxes.length ? [...fragmentBoxes, box] : [box]
              continue
            }

            if (!fragmentBoxes.length) {
              continue
            }

            fragmentBoxes.push(box)

            if (type === 'mdat') {
              enqueuePacket({
                data: Buffer.concat(fragmentBoxes),
                isLast: false,
              })
              fragmentBoxes = []
            }
          }

          if (consumed > 0) {
            pendingData = pendingData.subarray(consumed)
          }
        },
      })

      liveCall.requestKeyFrame()
      keyFrameTimer = setInterval(() => {
        if (closed || initSent) {
          if (keyFrameTimer) {
            clearInterval(keyFrameTimer)
            keyFrameTimer = undefined
          }
          return
        }

        liveCall?.requestKeyFrame()
      }, 2000)

      while (!closed) {
        if (packetQueue.length) {
          yield packetQueue.shift()!
          continue
        }

        await new Promise<void>((resolve) => {
          waitForPacket = resolve
          this.recordingWaiters.set(streamId, closeSession)
        })
      }
    } catch (e) {
      logError(`Failed to stream HKSV recording for ${this.ringCamera.name}`)
      logError(e)
      closeSession()
    } finally {
      this.recordingWaiters.delete(streamId)
      this.activeRecordingSessions.delete(streamId)

      if (keyFrameTimer) {
        clearInterval(keyFrameTimer)
      }

      if (liveCall) {
        liveCall.stop()
      }
    }
  }

  closeRecordingStream(streamId: number, reason: any) {
    logInfo(
      `HKSV recording stream closed for ${this.ringCamera.name} (streamId=${streamId}, reason=${String(reason)})`,
    )

    this.closedRecordingStreams.add(streamId)
    this.activeRecordingSessions.get(streamId)?.()
    this.recordingWaiters.get(streamId)?.()
    this.activeRecordingSessions.delete(streamId)
    this.recordingWaiters.delete(streamId)
  }

  acknowledgeStream(streamId: number) {
    logDebug(
      `HKSV recording stream acknowledged for ${this.ringCamera.name} (streamId=${streamId})`,
    )
  }
}
