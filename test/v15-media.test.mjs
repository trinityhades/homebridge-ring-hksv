import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ReplaySubject, Subject } from 'rxjs'
import { CameraSource } from '../lib/camera-source.js'
import { FragmentedMp4Parser } from '../lib/fragmented-mp4-parser.js'
import { ResourceGovernor } from '../lib/hksv-work-queue.js'
import { normalizeMediaConfig } from '../lib/media-config.js'
import { RingMediaIngress } from '../lib/ring-media-ingress.js'

function box(type, length = 8) {
  const value = Buffer.alloc(length)
  value.writeUInt32BE(length, 0)
  value.write(type, 4, 4, 'ascii')
  return value
}

function fakeSession() {
  const onCallEnded = new ReplaySubject(1)
  let didStop = false

  return {
    connection: { onCallAnswered: new ReplaySubject(1) },
    onCallEnded,
    onAudioRtp: new Subject(),
    onVideoRtp: new Subject(),
    isUsingOpus: Promise.resolve(false),
    requestKeyFrame() {},
    stop() {
      if (didStop) return
      didStop = true
      onCallEnded.next()
    },
    get didStop() {
      return didStop
    },
  }
}

test('normalizes v15 media settings while preserving legacy HKSV semantics', () => {
  const lowPower = normalizeMediaConfig({
    hksvPerformanceMode: 'rpi',
    hksvMaxRecordingSeconds: 0,
  })

  assert.equal(lowPower.profile, 'lowPower')
  assert.equal(lowPower.recording.maxQueuedBytes, 6 * 1024 * 1024)
  assert.equal(lowPower.recording.maxDurationSeconds, 0)
  assert.equal(
    normalizeMediaConfig({
      hksvPerformanceMode: 'rpi',
      media: { profile: 'quality', recording: { bitrateKbps: 5000 } },
    }).profile,
    'quality',
  )
  assert.throws(
    () => normalizeMediaConfig({ media: { recording: { unexpected: true } } }),
    /supported recording setting/,
  )
  assert.throws(
    () => normalizeMediaConfig({ media: { recording: { maxDurationSeconds: -1 } } }),
    /integer from 0 to 300/,
  )
})

test('retains only incomplete fragmented MP4 data under its parser bound', () => {
  const parser = new FragmentedMp4Parser(32)
  const packets = parser.append(Buffer.concat([
    box('ftyp'),
    box('moov'),
    box('styp'),
    box('moof'),
    box('mdat', 40),
  ]))

  assert.equal(packets.length, 2)
  assert.throws(
    () => new FragmentedMp4Parser(32).append(box('mdat', 40).subarray(0, 33)),
    /retained data exceeded/,
  )
})

test('uses available recording capacity without allowing a second encoder per camera', async () => {
  const governor = new ResourceGovernor({ recordingConcurrency: 2 })
  const firstA = await governor.acquireLease({ cameraId: 'a' })
  const waitingA = governor.acquireLease({ cameraId: 'a' })
  const firstB = await governor.acquireLease({ cameraId: 'b' })

  firstB.setQueuedBytes(123)
  assert.equal(governor.getMetrics().activeRecordings, 2)
  assert.equal(governor.getMetrics().queuedRecordings, 1)
  assert.equal(governor.getMetrics().queuedBytes, 123)

  firstB.release()
  firstA.release()
  const secondA = await waitingA
  assert.equal(governor.getMetrics().activeRecordings, 1)
  secondA.release()
})

test('cancels unanswered or disposed Ring media ingress startup', async () => {
  const earlySession = fakeSession()
  const ingress = new RingMediaIngress({
    name: 'test camera',
    startLiveCall: async () => earlySession,
  })
  const lease = await ingress.acquire('test')
  const starting = lease.createTranscoder({ video: false, output: [], label: 'test' })
  earlySession.onCallEnded.next()
  await assert.rejects(starting, /ended before the media SDP was answered/)
  lease.release()

  const abortController = new AbortController()
  const abortSession = fakeSession()
  const abortIngress = new RingMediaIngress({
    name: 'abortable camera',
    startLiveCall: async () => abortSession,
  })
  const abortLease = await abortIngress.acquire('test')
  const aborting = abortLease.createTranscoder({
    signal: abortController.signal,
    video: false,
    output: [],
    label: 'test',
  })
  abortController.abort()
  await assert.rejects(aborting, { name: 'AbortError' })
  abortLease.release()
  abortIngress.shutdown()

  let resolveLiveCall
  const lateSession = fakeSession()
  const pendingIngress = new RingMediaIngress({
    name: 'pending camera',
    startLiveCall: () => new Promise((resolve) => { resolveLiveCall = resolve }),
  })
  const pendingAcquire = pendingIngress.acquire('test')
  pendingIngress.shutdown()
  resolveLiveCall(lateSession)

  await assert.rejects(pendingAcquire, /ended before it could be acquired/)
  assert.equal(lateSession.didStop, true)
})

test('exposes all media recording controls and applies CBR arguments', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'),
  )
  const recordingSchema = schema.schema.properties.media.properties.recording

  for (const key of [
    'codec', 'bitrateKbps', 'maxBitrateKbps', 'bufferSizeKbps', 'rateControl',
    'crf', 'preset', 'keyframeInterval', 'prebufferLengthMs', 'fragmentLengthMs',
    'maxDurationSeconds', 'maxQueuedBytes', 'maxConcurrentRecordings',
  ]) {
    assert.ok(key in recordingSchema.properties, `schema should expose ${key}`)
  }
  assert.equal(recordingSchema.additionalProperties, false)

  const source = Object.create(CameraSource.prototype)
  source.config = {
    media: {
      recording: {
        codec: 'libx264',
        rateControl: 'cbr',
        bitrateKbps: 2000,
        maxBitrateKbps: 4000,
        bufferSizeKbps: 4000,
        crf: 20,
      },
    },
  }
  const cbrArgs = source.getHksvVideoArguments({ encoders: new Set() })

  assert.deepEqual(cbrArgs.slice(cbrArgs.indexOf('-minrate'), cbrArgs.indexOf('-bufsize')), [
    '-minrate', '2000k', '-maxrate', '2000k',
  ])
  assert.equal(cbrArgs.includes('-crf'), false)
})
