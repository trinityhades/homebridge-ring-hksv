import {
  defaultFfmpegPath,
  reservePorts,
  RtpSplitter,
} from '@homebridge/camera-utils'
import type { RingCamera } from 'ring-client-api'
import { getFfmpegPath } from 'ring-client-api/ffmpeg'
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session'
import { logDebug, logError, logInfo } from 'ring-client-api/util'
import { Subscription } from 'rxjs'
import { take } from 'rxjs/operators'
import { RtpPacket } from 'werift'
import { hksvRecordingQueue } from './hksv-work-queue.ts'
import { ManagedFfmpegProcess } from './managed-ffmpeg-process.ts'

/**
 * A camera-local owner for a Ring call.  ring-client-api's startTranscoding()
 * ties each ffmpeg exit to the entire call, so consumers must use this class
 * rather than attaching their lifecycle to StreamingSession.
 */
export type MediaIngressState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'draining'
  | 'closed'
  | 'failed'

export interface MediaIngressLease {
  readonly session: StreamingSession
  subscribeVideo(handler: (packet: RtpPacket) => void): Subscription
  subscribeAudio(handler: (packet: RtpPacket) => void): Subscription
  createTranscoder(options: IngressTranscoderOptions): Promise<IngressTranscoder>
  release(): void
}

export interface IngressTranscoderOptions {
  /** Cancels setup without tearing down the shared Ring call. */
  signal?: AbortSignal
  input?: Array<string | number>
  video?: Array<string | number> | false
  audio?: Array<string | number>
  output: Array<string | number>
  stdoutCallback?: (data: Buffer) => void
  label: string
  onExit?: () => void
}

export interface IngressTranscoder {
  stop(): void
  /** Resolves only after the owned FFmpeg child has actually exited. */
  readonly exited: Promise<void>
}

interface ActiveCall {
  id: number
  promise: Promise<StreamingSession>
  session?: StreamingSession
  leases: number
  ended: boolean
  releaseResource?: () => void
}

function clonePacket(packet: RtpPacket) {
  // Consumers alter SSRC/payload type. Serializing is intentionally the
  // isolation boundary: no HomeKit consumer may mutate Ring's RTP packet or a
  // sibling consumer's view of it.
  return RtpPacket.deSerialize(packet.serialize())
}

function cleanSdp(sdp: string, includeVideo: boolean) {
  return sdp
    .split('\nm=')
    .slice(1)
    .map((section) => 'm=' + section)
    .filter((section) => includeVideo || !section.startsWith('m=video'))
    .join('\n')
}

function getAbortError() {
  const error = new Error('Ring media transcoder startup was aborted')
  error.name = 'AbortError'
  return error
}

function waitForAbortablePromise<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(getAbortError())

  return new Promise<T>((resolve, reject) => {
    let onAbort: () => void = () => undefined
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    onAbort = () => {
      cleanup()
      reject(getAbortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )

    if (signal.aborted) onAbort()
  })
}

function waitForSdp(
  session: StreamingSession,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) {
    return Promise.reject(getAbortError())
  }

  const connection = (session as any).connection
  return new Promise((resolve, reject) => {
    const subscriptions = new Subscription()
    const abort = { listener: undefined as (() => void) | undefined }
    let settled = false
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      subscriptions.unsubscribe()
      if (abort.listener) {
        signal?.removeEventListener('abort', abort.listener)
      }
      callback()
    }
    const onAbort = () => settle(() => reject(getAbortError()))
    abort.listener = onAbort

    const answeredSubscription = connection.onCallAnswered
      .pipe(take(1))
      .subscribe({
        next: (sdp: string) => settle(() => resolve(sdp)),
        error: (error: unknown) => settle(() => reject(error)),
      })
    subscriptions.add(answeredSubscription)
    if (settled) return

    const endedSubscription = session.onCallEnded.pipe(take(1)).subscribe(() => {
      settle(() => resolve(undefined))
    })
    subscriptions.add(endedSubscription)
    if (settled) return

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

export class RingMediaIngress {
  private readonly camera: RingCamera
  private readonly idleGraceMs: number
  private active?: ActiveCall
  private nextId = 1
  private idleTimer?: ReturnType<typeof setTimeout>
  public state: MediaIngressState = 'idle'

  constructor(camera: RingCamera, idleGraceMs = 5_000) {
    this.camera = camera
    this.idleGraceMs = idleGraceMs
  }

  async acquire(
    consumer: string,
    signal?: AbortSignal,
  ): Promise<MediaIngressLease> {
    if (signal?.aborted) {
      throw getAbortError()
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }

    const active = this.active?.ended ? undefined : this.active
    const call = active ?? this.createCall(consumer)
    if (active?.session) {
      this.state = 'ready'
    }
    call.leases++

    try {
      const session = await waitForAbortablePromise(call.promise, signal)
      if (call.ended) {
        throw new Error('Ring media ingress ended before it could be acquired')
      }

      let released = false
      return {
        session,
        subscribeVideo: (handler) => session.onVideoRtp.subscribe((packet) => handler(clonePacket(packet))),
        subscribeAudio: (handler) => session.onAudioRtp.subscribe((packet) => handler(clonePacket(packet))),
        createTranscoder: (options) => this.createTranscoder(session, options),
        release: () => {
          if (released) return
          released = true
          this.release(call)
        },
      }
    } catch (error) {
      this.release(call)
      throw error
    }
  }

  shutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const call = this.active
    this.active = undefined
    this.state = 'closed'
    if (!call) return

    call.ended = true
    call.releaseResource?.()
    call.session?.stop()
    // startLiveCall() may still be resolving when Homebridge disposes the
    // camera. Stop that late session as soon as it becomes available.
    call.promise.then((session) => session.stop()).catch(() => undefined)
  }

  private createCall(consumer: string): ActiveCall {
    const call: ActiveCall = {
      id: this.nextId++,
      promise: undefined as unknown as Promise<StreamingSession>,
      leases: 0,
      ended: false,
      releaseResource: hksvRecordingQueue.trackRingCall(),
    }
    this.active = call
    this.state = 'connecting'
    logInfo(`Starting Ring media ingress for ${this.camera.name} (${consumer})`)
    call.promise = this.camera.startLiveCall().then((session) => {
      call.session = session

      if (call.ended || this.active !== call) {
        session.stop()
        return session
      }

      this.state = 'ready'
      session.onCallEnded.pipe(take(1)).subscribe(() => {
        call.ended = true
        call.releaseResource?.()
        if (this.active === call) {
          this.active = undefined
          this.state = 'closed'
        }
      })
      return session
    }).catch((error) => {
      call.ended = true
      call.releaseResource?.()
      if (this.active === call) {
        this.active = undefined
        this.state = 'failed'
      }
      throw error
    })
    return call
  }

  private release(call: ActiveCall) {
    call.leases = Math.max(0, call.leases - 1)
    if (call.leases || call.ended || this.active !== call) return
    this.state = 'draining'
    this.idleTimer = setTimeout(() => {
      if (call.leases || call.ended || this.active !== call) return
      logDebug(`Stopping idle Ring media ingress for ${this.camera.name} (session=${call.id})`)
      this.active = undefined
      this.idleTimer = undefined
      this.state = 'closed'
      call.releaseResource?.()
      call.session?.stop()
      call.promise.then((session) => {
        if (!call.leases && !call.ended) session.stop()
      }).catch(() => undefined)
    }, this.idleGraceMs)
  }

  private async createTranscoder(
    session: StreamingSession,
    options: IngressTranscoderOptions,
  ): Promise<IngressTranscoder> {
    const audioSplitter = new RtpSplitter()
    const videoSplitter = options.video === false ? undefined : new RtpSplitter()
    const subscriptions = new Subscription()
    let ffmpeg: ManagedFfmpegProcess | undefined
    let releaseFfmpeg: (() => void) | undefined
    let stopped = false
    const releaseFfmpegResource = () => {
      releaseFfmpeg?.()
      releaseFfmpeg = undefined
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      subscriptions.unsubscribe()
      audioSplitter.close()
      videoSplitter?.close()
      ffmpeg?.stop()
      if (!ffmpeg) releaseFfmpegResource()
    }

    try {
      if (options.signal?.aborted) {
        throw getAbortError()
      }

      const sdp = await waitForSdp(session, options.signal)

      if (!sdp) {
        throw new Error('Ring call ended before the media SDP was answered')
      }

      if (options.signal?.aborted) {
        throw getAbortError()
      }

      // FFmpeg owns the receive ports. RtpSplitter is only the source socket
      // that forwards Ring packets to them. Binding a splitter to these ports
      // first causes FFmpeg to fail with EADDRINUSE.
      const [audioPort] = await reservePorts({ count: 2 })
      const [videoPort] = videoSplitter
        ? await reservePorts({ count: 2 })
        : [0]
      if (options.signal?.aborted) {
        throw getAbortError()
      }
      const inputSdp = cleanSdp(sdp, Boolean(videoSplitter))
        .replace(/m=audio \d+/, `m=audio ${audioPort}`)
        .replace(/m=video \d+/, `m=video ${videoPort}`)

      subscriptions.add(session.onAudioRtp.subscribe((packet) => {
        audioSplitter.send(packet.serialize(), { port: audioPort }).catch(logError)
      }))
      if (videoSplitter) {
        subscriptions.add(session.onVideoRtp.subscribe((packet) => {
          videoSplitter.send(packet.serialize(), { port: videoPort }).catch(logError)
        }))
      }

      const usingOpus = await session.isUsingOpus
      if (options.signal?.aborted) {
        throw getAbortError()
      }
      releaseFfmpeg = hksvRecordingQueue.trackFfmpegProcess()
      ffmpeg = new ManagedFfmpegProcess({
        ffmpegPath: getFfmpegPath() || defaultFfmpegPath,
        ffmpegArgs: [
          '-hide_banner', '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
          ...(usingOpus ? ['-acodec', 'libopus'] : []),
          '-f', 'sdp', ...(options.input ?? []), '-i', 'pipe:',
          ...(options.audio ?? ['-acodec', 'aac']),
          ...(videoSplitter ? (options.video || ['-vcodec', 'copy']) : []),
          ...options.output,
        ],
        stdoutCallback: options.stdoutCallback,
        exitCallback: () => {
          releaseFfmpegResource()
          stop()
          options.onExit?.()
        },
        logLabel: options.label,
        logger: { error: logError, info: logDebug },
      })
      subscriptions.add(session.onCallEnded.pipe(take(1)).subscribe(stop))
      if (stopped) {
        ffmpeg.stop()
        throw new Error('Ring call ended before the media transcoder started')
      }
      ffmpeg.writeStdin(inputSdp)
      session.requestKeyFrame()
      return { stop, exited: ffmpeg.exited }
    } catch (error) {
      stop()
      throw error
    }
  }
}
