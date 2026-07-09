import type { RingPlatformConfig } from './config.ts'

export type MediaProfile = 'adaptive' | 'lowPower' | 'quality'

export type HksvVideoCodec =
  | 'auto'
  | 'copy'
  | 'libx264'
  | 'h264_v4l2m2m'
  | 'h264_videotoolbox'

export type HksvVideoPreset =
  | 'ultrafast'
  | 'superfast'
  | 'veryfast'
  | 'faster'
  | 'fast'
  | 'medium'
  | 'slow'
  | 'slower'
  | 'veryslow'

export type MediaRateControl = 'cbr' | 'vbr'

export interface MediaRecordingConfigInput {
  codec?: HksvVideoCodec
  bitrateKbps?: number
  maxBitrateKbps?: number
  bufferSizeKbps?: number
  rateControl?: MediaRateControl
  crf?: number
  preset?: HksvVideoPreset
  keyframeInterval?: number
  prebufferLengthMs?: number
  fragmentLengthMs?: number
  maxDurationSeconds?: number
  maxQueuedBytes?: number
  maxConcurrentRecordings?: number
}

export interface MediaConfigInput {
  profile?: MediaProfile
  recording?: MediaRecordingConfigInput
}

export interface NormalizedMediaRecordingConfig {
  codec: HksvVideoCodec
  bitrateKbps: number
  maxBitrateKbps: number
  bufferSizeKbps: number
  rateControl: MediaRateControl
  crf?: number
  preset: HksvVideoPreset
  keyframeInterval: number
  prebufferLengthMs: number
  fragmentLengthMs: number
  maxDurationSeconds?: number
  maxQueuedBytes: number
  maxConcurrentRecordings: number
}

export interface NormalizedMediaConfig {
  profile: MediaProfile
  recording: NormalizedMediaRecordingConfig
}

const codecs: readonly HksvVideoCodec[] = [
  'auto',
  'copy',
  'libx264',
  'h264_v4l2m2m',
  'h264_videotoolbox',
]
const presets: readonly HksvVideoPreset[] = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow',
  'slower', 'veryslow',
]
const mediaKeys = new Set(['profile', 'recording'])
const recordingKeys = new Set<keyof MediaRecordingConfigInput>([
  'codec',
  'bitrateKbps',
  'maxBitrateKbps',
  'bufferSizeKbps',
  'rateControl',
  'crf',
  'preset',
  'keyframeInterval',
  'prebufferLengthMs',
  'fragmentLengthMs',
  'maxDurationSeconds',
  'maxQueuedBytes',
  'maxConcurrentRecordings',
])

function invalid(path: string, expectation: string): never {
  throw new Error(`Invalid media configuration at ${path}: expected ${expectation}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getMediaInput(config: RingPlatformConfig) {
  const media = config.media as unknown
  if (media === undefined) {
    return { profile: undefined, recording: {} as Record<string, unknown> }
  }

  if (!isRecord(media)) {
    return invalid('media', 'an object')
  }

  for (const key of Object.keys(media)) {
    if (!mediaKeys.has(key)) {
      return invalid(`media.${key}`, 'a supported media setting')
    }
  }

  if (media.recording === undefined) {
    return { profile: media.profile, recording: {} as Record<string, unknown> }
  }

  if (!isRecord(media.recording)) {
    return invalid('media.recording', 'an object')
  }

  for (const key of Object.keys(media.recording)) {
    if (!recordingKeys.has(key as keyof MediaRecordingConfigInput)) {
      return invalid(`media.recording.${key}`, 'a supported recording setting')
    }
  }

  return { profile: media.profile, recording: media.recording }
}

function enumValue<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return invalid(path, values.join(', '))
  }
  return value as T
}

function integer(
  value: unknown,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    return invalid(path, `an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function legacyInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  // Keep the flat v14 options compatible: they were rounded and clamped at
  // consumption time. Nested v15 values use integer() and fail fast instead.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.min(Math.max(Math.round(value), minimum), maximum)
}

function preferInteger(
  modern: unknown,
  legacy: unknown,
  path: string,
  fallback: number,
  minimum: number,
  maximum: number,
  legacyMinimum = minimum,
) {
  return modern === undefined
    ? legacyInteger(legacy, fallback, legacyMinimum, maximum)
    : integer(modern, path, fallback, minimum, maximum)
}

function preferOptionalInteger(
  modern: unknown,
  legacy: unknown,
  path: string,
  minimum: number,
  maximum: number,
  legacyMinimum = minimum,
): number | undefined {
  if (modern !== undefined) {
    return integer(modern, path, minimum, minimum, maximum)
  }

  if (typeof legacy !== 'number' || !Number.isFinite(legacy)) {
    return undefined
  }

  return Math.min(Math.max(Math.round(legacy), legacyMinimum), maximum)
}

function legacyEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
) {
  return typeof value === 'string' && values.includes(value as T)
    ? value as T
    : fallback
}

function preferEnum<T extends string>(
  modern: unknown,
  legacy: unknown,
  path: string,
  values: readonly T[],
  fallback: T,
) {
  return modern === undefined
    ? legacyEnum(legacy, values, fallback)
    : enumValue(modern, path, values, fallback)
}

function getProfile(
  config: RingPlatformConfig,
  modernProfile: unknown,
): MediaProfile {
  // The nested v15 setting is authoritative when both forms are present.
  // This makes it safe for config UIs to retain legacy fields during upgrade.
  if (modernProfile !== undefined) {
    return enumValue(modernProfile, 'media.profile', ['adaptive', 'lowPower', 'quality'], 'adaptive')
  }
  return config.hksvPerformanceMode === 'rpi'
    ? 'lowPower'
    : config.hksvPerformanceMode === 'quality' ? 'quality' : 'adaptive'
}

/**
 * Converts legacy flat HKSV options and v15 media options into one validated
 * configuration. New nested recording values intentionally win over legacy
 * values; legacy fields remain supported while users migrate.
 */
export function normalizeMediaConfig(config: RingPlatformConfig): NormalizedMediaConfig {
  const media = getMediaInput(config)
  const profile = getProfile(config, media.profile)
  const input = media.recording
  const lowPower = profile === 'lowPower'
  const bitrateKbps = preferInteger(input.bitrateKbps, config.hksvVideoBitrateKbps, 'media.recording.bitrateKbps', lowPower ? 1000 : profile === 'quality' ? 5000 : 3000, 256, 12000)
  const maxBitrateKbps = preferInteger(input.maxBitrateKbps, config.hksvVideoMaxBitrateKbps, 'media.recording.maxBitrateKbps', bitrateKbps * 2, bitrateKbps, 20000)
  const bufferSizeKbps = preferInteger(input.bufferSizeKbps, config.hksvVideoBufferSizeKbps, 'media.recording.bufferSizeKbps', maxBitrateKbps * 2, maxBitrateKbps, 40000)

  return {
    profile,
    recording: {
      codec: preferEnum(input.codec, config.cameraVideoCodec, 'media.recording.codec', codecs, lowPower ? 'copy' : 'auto'),
      bitrateKbps,
      maxBitrateKbps,
      bufferSizeKbps,
      rateControl: enumValue(input.rateControl, 'media.recording.rateControl', ['cbr', 'vbr'], 'vbr'),
      crf: preferOptionalInteger(input.crf, config.hksvVideoCrf, 'media.recording.crf', 18, 35),
      preset: preferEnum(input.preset, config.hksvVideoPreset, 'media.recording.preset', presets, lowPower ? 'ultrafast' : 'veryfast'),
      keyframeInterval: preferInteger(input.keyframeInterval, config.hksvVideoKeyframeInterval, 'media.recording.keyframeInterval', 30, 5, 240),
      prebufferLengthMs: preferInteger(input.prebufferLengthMs, config.hksvPrebufferLengthMs, 'media.recording.prebufferLengthMs', 4000, 4000, 16000),
      fragmentLengthMs: preferInteger(input.fragmentLengthMs, config.hksvFragmentLengthMs, 'media.recording.fragmentLengthMs', 4000, 1000, 8000),
      maxDurationSeconds: preferOptionalInteger(input.maxDurationSeconds, config.hksvMaxRecordingSeconds, 'media.recording.maxDurationSeconds', 0, 300, 0),
      maxQueuedBytes: preferInteger(input.maxQueuedBytes, config.hksvMaxQueuedBytes, 'media.recording.maxQueuedBytes', lowPower ? 6 * 1024 * 1024 : 16 * 1024 * 1024, 1024 * 1024, 64 * 1024 * 1024),
      maxConcurrentRecordings: preferInteger(input.maxConcurrentRecordings, config.hksvMaxConcurrentRecordings, 'media.recording.maxConcurrentRecordings', lowPower ? 1 : 2, 1, 4),
    },
  }
}

/** Maps v15 profiles to the legacy names used by existing camera code. */
export function getLegacyHksvPerformanceMode(config: RingPlatformConfig) {
  const profile = normalizeMediaConfig(config).profile
  return profile === 'lowPower' ? 'rpi' : profile === 'quality' ? 'quality' : 'balanced'
}
