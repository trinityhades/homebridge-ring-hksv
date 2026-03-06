import type { AlarmMode, RingApiOptions } from 'ring-client-api'
import { logError } from 'ring-client-api/util'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { API } from 'homebridge'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'

const systemIdFileName = '.ring.json'
export const controlCenterDisplayName = 'homebridge-ring-hksv'

export interface RingPlatformConfig extends RingApiOptions {
  alarmOnEntryDelay?: boolean
  enableHksv?: boolean
  disableHksvOnBattery?: boolean
  hksvPrebufferLengthMs?: number
  hksvFragmentLengthMs?: number
  hksvMaxRecordingSeconds?: number
  cameraVideoCodec?: 'h264_videotoolbox' | 'libx264'
  beamDurationSeconds?: number
  ffmpegPath?: string
  hideLightGroups?: boolean
  hideDoorbellSwitch?: boolean
  hideCameraLight?: boolean
  hideCameraMotionSensor?: boolean
  hideCameraSirenSwitch?: boolean
  hideInHomeDoorbellSwitch?: boolean
  hideAlarmSirenSwitch?: boolean
  externalCameraIdSalt?: string
  hideDeviceIds?: string[]
  nightModeBypassFor: AlarmMode
  onlyDeviceTypes?: string[]
  showPanicButtons?: boolean
  disableLogs?: boolean
}

export function updateHomebridgeConfig(
  homebridge: API,
  update: (config: string) => string,
) {
  try {
    const configPath = homebridge.user.configPath(),
      config = readFileSync(configPath).toString(),
      updatedConfig = update(config)

    if (config !== updatedConfig) {
      writeFileSync(configPath, updatedConfig)
      return true
    }
  } catch (error) {
    logError('Failed to update Homebridge config')
    logError(error)
  }

  return false
}

function createSystemId() {
  return createHash('sha256').update(randomBytes(32)).digest('hex')
}

interface RingContext {
  systemId: string
}

export function getSystemId(homebridgeStoragePath: string) {
  const filePath = join(homebridgeStoragePath, systemIdFileName)

  try {
    const ringContext: RingContext = JSON.parse(
      readFileSync(filePath).toString(),
    )
    if (ringContext.systemId) {
      return ringContext.systemId
    }
  } catch {
    // expect errors if file doesn't exist or is in a bad format
  }

  const systemId = createSystemId(),
    ringContext: RingContext = { systemId }

  try {
    mkdirSync(homebridgeStoragePath, { recursive: true })
    writeFileSync(filePath, JSON.stringify(ringContext))
  } catch (error) {
    logError('Failed to persist Ring system id')
    logError(error)
  }

  return systemId
}

export const debug = process.env.RING_DEBUG === 'true'
