import type { RingPlatformConfig } from './config.ts'
import type { FfmpegCapabilities } from './ffmpeg-capabilities.ts'

export type HksvVideoCodec =
  | 'auto'
  | 'copy'
  | 'libx264'
  | 'h264_v4l2m2m'
  | 'h264_videotoolbox'

export function getHksvPerformanceMode(config: RingPlatformConfig) {
  return config.hksvPerformanceMode ?? 'balanced'
}

export function getHksvRecordingResolutions(config: RingPlatformConfig) {
  if (getHksvPerformanceMode(config) === 'rpi') {
    return [
      [1280, 720, 30],
      [640, 480, 30],
      [640, 360, 30],
      [320, 240, 15],
    ]
  }

  return [
    [1920, 1080, 30],
    [1280, 720, 30],
    [640, 480, 30],
    [320, 240, 15],
  ]
}

export function selectHksvVideoCodec(
  configuredCodec: HksvVideoCodec | undefined,
  capabilities: FfmpegCapabilities | undefined,
  config: RingPlatformConfig,
): HksvVideoCodec {
  const codec = configuredCodec ?? 'auto'

  if (codec !== 'auto') {
    return codec
  }

  if (getHksvPerformanceMode(config) === 'rpi') {
    return 'copy'
  }

  if (capabilities?.encoders.has('h264_v4l2m2m')) {
    return 'h264_v4l2m2m'
  }

  if (capabilities?.encoders.has('h264_videotoolbox')) {
    return 'h264_videotoolbox'
  }

  return 'libx264'
}
