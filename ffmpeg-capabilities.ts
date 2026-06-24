import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getFfmpegPath } from 'ring-client-api/ffmpeg'
import { logDebug } from 'ring-client-api/util'

const execFileAsync = promisify(execFile)

export interface FfmpegCapabilities {
  encoders: Set<string>
  hwaccels: Set<string>
}

let cachedCapabilities: Promise<FfmpegCapabilities> | undefined

function parseNames(output: string) {
  return new Set(
    output
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
}

async function getFfmpegOutput(args: string[]) {
  const ffmpegPath = getFfmpegPath() || 'ffmpeg'

  try {
    const { stdout, stderr } = await execFileAsync(ffmpegPath, args, {
      maxBuffer: 1024 * 1024,
    })

    return `${stdout}\n${stderr}`
  } catch (e: any) {
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
}

async function loadCapabilities(): Promise<FfmpegCapabilities> {
  const [encodersOutput, hwaccelsOutput] = await Promise.all([
    getFfmpegOutput(['-hide_banner', '-encoders']),
    getFfmpegOutput(['-hide_banner', '-hwaccels']),
  ])

  const capabilities = {
    encoders: parseNames(encodersOutput),
    hwaccels: parseNames(hwaccelsOutput),
  }

  logDebug(
    `FFmpeg HKSV capabilities: encoders=${[
      'h264_v4l2m2m',
      'h264_videotoolbox',
      'libx264',
    ]
      .filter((encoder) => capabilities.encoders.has(encoder))
      .join(',') || 'none detected'}`,
  )

  return capabilities
}

export function getFfmpegCapabilities() {
  cachedCapabilities ??= loadCapabilities()
  return cachedCapabilities
}
