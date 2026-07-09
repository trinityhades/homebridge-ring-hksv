import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ReplaySubject, Subject } from 'rxjs'
import { CameraSource } from '../lib/camera-source.js'
import { FragmentedMp4Parser } from '../lib/fragmented-mp4-parser.js'
import { ResourceGovernor } from '../lib/hksv-work-queue.js'
import { ManagedFfmpegProcess } from '../lib/managed-ffmpeg-process.js'
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function within(promise, timeoutMs) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`timed out after ${timeoutMs}ms`)
    }),
  ])
}

function startManagedNodeChild({ ignoreTerm, stopGraceMs }) {
  let markReady
  let markExited
  const ready = new Promise((resolve) => { markReady = resolve })
  const exit = new Promise((resolve) => { markExited = resolve })
  const ffmpeg = new ManagedFfmpegProcess({
    ffmpegPath: process.execPath,
    ffmpegArgs: [
      '-e',
      [
        "process.stdout.write('ready\\n')",
        ignoreTerm ? "process.on('SIGTERM', () => {})" : '',
        'setInterval(() => {}, 1000)',
      ].filter(Boolean).join(';'),
    ],
    logLabel: 'test child',
    logger: { error() {}, info() {} },
    stopGraceMs,
    stdoutCallback: (data) => {
      if (data.toString().includes('ready')) markReady()
    },
    exitCallback: (code, signal) => markExited({ code, signal }),
  })

  return { ffmpeg, ready, exit }
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

  let resolveAbortableCall
  const delayedSession = fakeSession()
  const abortableIngress = new RingMediaIngress({
    name: 'abortable acquire camera',
    startLiveCall: () => new Promise((resolve) => { resolveAbortableCall = resolve }),
  }, 0)
  const acquireAbortController = new AbortController()
  const abortedAcquire = abortableIngress.acquire('test', acquireAbortController.signal)
  acquireAbortController.abort()
  await assert.rejects(abortedAcquire, { name: 'AbortError' })
  resolveAbortableCall(delayedSession)
  await within(delay(0), 1_000)
  assert.equal(delayedSession.didStop, true)
})

test('honors Homebridge recording cancellation before pipeline startup', async () => {
  const source = Object.create(CameraSource.prototype)
  source.ringCamera = { id: 'test-camera', name: 'test camera' }
  source.config = {}
  source.recordingActive = true
  source.recordingConfiguration = {
    mediaContainerConfiguration: { fragmentLength: 4_000 },
  }
  source.closedRecordingStreams = new Set()
  source.recordingWaiters = new Map()
  source.activeRecordingSessions = new Map()

  const abortController = new AbortController()
  abortController.abort()
  const generator = source.handleRecordingStreamRequest(1, abortController.signal)

  assert.equal((await within(generator.next(), 1_000)).done, true)
  assert.equal(source.activeRecordingSessions.size, 0)
  assert.equal(source.recordingWaiters.size, 0)
})

test('escalates a non-terminating FFmpeg child without killing a normal child', async () => {
  const stuck = startManagedNodeChild({ ignoreTerm: true, stopGraceMs: 25 })
  try {
    await within(stuck.ready, 1_000)
    stuck.ffmpeg.stop()
    assert.deepEqual(await within(stuck.exit, 1_000), {
      code: null,
      signal: 'SIGKILL',
    })
  } finally {
    stuck.ffmpeg.forceStop()
    await within(stuck.ffmpeg.exited, 1_000)
  }

  const normal = startManagedNodeChild({ ignoreTerm: false, stopGraceMs: 200 })
  try {
    await within(normal.ready, 1_000)
    normal.ffmpeg.stop()
    assert.deepEqual(await within(normal.exit, 1_000), {
      code: null,
      signal: 'SIGTERM',
    })
  } finally {
    normal.ffmpeg.forceStop()
    await within(normal.ffmpeg.exited, 1_000)
  }
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
