import type { RingCamera, RingChime, RingDevice, RingIntercom } from 'ring-client-api'
import { hap } from './hap.ts'
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge'
import { Chime } from './chime.ts'
import { BrightnessOnly } from './brightness-only.ts'
import { ContactSensor } from './contact-sensor.ts'
import { MotionSensor } from './motion-sensor.ts'
import { Lock } from './lock.ts'
import { SmokeAlarm } from './smoke-alarm.ts'
import { CoAlarm } from './co-alarm.ts'
import { SmokeCoListener } from './smoke-co-listener.ts'
import type { RingPlatformConfig } from './config.ts'
import {
  controlCenterDisplayName,
  debug,
  getSystemId,
  updateHomebridgeConfig,
} from './config.ts'
import { MultiLevelSwitch } from './multi-level-switch.ts'
import { Fan } from './fan.ts'
import { Outlet } from './outlet.ts'
import { Switch } from './switch.ts'
import { PanicButtons } from './panic-buttons.ts'
import type { RefreshTokenAuth } from 'ring-client-api/rest-client'
import { logError, logInfo, useLogger } from 'ring-client-api/util'
import type { BaseAccessory } from './base-accessory.ts'
import { FloodFreezeSensor } from './flood-freeze-sensor.ts'
import { FreezeSensor } from './freeze-sensor.ts'
import { TemperatureSensor } from './temperature-sensor.ts'
import { WaterSensor } from './water-sensor.ts'
import { LocationModeSwitch } from './location-mode-switch.ts'
import { UnknownZWaveSwitchSwitch } from './unknown-zwave-switch.ts'
import { generateMacAddress } from './util.ts'
import { Intercom } from './intercom.ts'
import { Valve } from './valve.ts'
import { RingDeviceCategory, RingDeviceType } from './ring-values.ts'

type AccessoryClass = new (...args: any[]) => BaseAccessory<any>
type LazyAccessoryClass = 'beam' | 'security-panel' | 'thermostat'
type AccessoryMatch = AccessoryClass | LazyAccessoryClass | null

let cameraAccessoryPromise: Promise<AccessoryClass> | undefined

function loadCameraAccessoryClass() {
  cameraAccessoryPromise ??= import('./camera.ts').then(
    ({ Camera }) => Camera as AccessoryClass,
  )

  return cameraAccessoryPromise
}

function hasUsableRefreshToken(refreshToken?: string) {
  if (!refreshToken) {
    return false
  }

  const normalized = refreshToken.trim()

  if (normalized.length < 32) {
    return false
  }

  return !/^(refresh token|refresh-token|token|test|example|changeme)$/i.test(
    normalized,
  ) && !/your-refresh-token/i.test(normalized)
}

const ignoreHiddenDeviceTypes: string[] = [
  RingDeviceType.RingNetAdapter,
  RingDeviceType.ZigbeeAdapter,
  RingDeviceType.CodeVault,
  RingDeviceType.SecurityAccessCode,
  RingDeviceType.ZWaveAdapter,
  RingDeviceType.ZWaveExtender,
  RingDeviceType.BeamsDevice,
  RingDeviceType.PanicButton,
]

export const platformName = 'RingHKSV'
export const pluginName = 'homebridge-ring-hksv'

function getAccessoryClass(
  device: RingDevice,
): AccessoryMatch {
  const { deviceType } = device

  if (device.data.status === 'disabled') {
    return null
  }

  switch (deviceType) {
    case RingDeviceType.ContactSensor:
    case RingDeviceType.RetrofitZone:
    case RingDeviceType.TiltSensor:
    case RingDeviceType.GlassbreakSensor:
      return ContactSensor
    case RingDeviceType.MotionSensor:
      return MotionSensor
    case RingDeviceType.FloodFreezeSensor:
      return FloodFreezeSensor
    case RingDeviceType.FreezeSensor:
      return FreezeSensor
    case RingDeviceType.SecurityPanel:
      return 'security-panel'
    case RingDeviceType.BaseStation:
    case RingDeviceType.BaseStationPro:
    case RingDeviceType.Keypad:
      return BrightnessOnly
    case RingDeviceType.SmokeAlarm:
      return SmokeAlarm
    case RingDeviceType.CoAlarm:
      return CoAlarm
    case RingDeviceType.SmokeCoListener:
    case RingDeviceType.KiddeSmokeCoAlarm:
      return SmokeCoListener
    case RingDeviceType.BeamsMotionSensor:
    case RingDeviceType.BeamsSwitch:
    case RingDeviceType.BeamsMultiLevelSwitch:
    case RingDeviceType.BeamsTransformerSwitch:
    case RingDeviceType.BeamsLightGroupSwitch:
      return 'beam'
    case RingDeviceType.MultiLevelSwitch:
      return device.categoryId === RingDeviceCategory.Fans
        ? Fan
        : MultiLevelSwitch
    case RingDeviceType.MultiLevelBulb:
      return MultiLevelSwitch
    case RingDeviceType.Switch:
      return device.categoryId === RingDeviceCategory.Outlets
        ? Outlet
        : Switch
    case RingDeviceType.TemperatureSensor:
      return TemperatureSensor
    case RingDeviceType.WaterSensor:
      return WaterSensor
    case RingDeviceType.Thermostat:
      return 'thermostat'
    case RingDeviceType.WaterValve:
      return Valve
    case RingDeviceType.UnknownZWave:
      return UnknownZWaveSwitchSwitch
  }

  if (/^lock($|\.)/.test(deviceType)) {
    return Lock
  }

  if (deviceType === RingDeviceType.Sensor) {
    // Generic sensor that could be any type of sensor, but should at least have `faulted`
    if (device.name.toLowerCase().includes('motion')) {
      return MotionSensor
    }
    return ContactSensor
  }

  return null
}

export class RingPlatform implements DynamicPlatformPlugin {
  private readonly homebridgeAccessories: {
    [uuid: string]: PlatformAccessory
  } = {}

  public log
  public config
  public api

  constructor(
    log: Logging,
    config: PlatformConfig & RingPlatformConfig & RefreshTokenAuth,
    api: API,
  ) {
    this.log = log
    this.config = config
    this.api = api

    if (!config.disableLogs) {
      useLogger({
        logInfo(message) {
          log.info(message)
        },
        logError(message) {
          log.error(message)
        },
      })
    }

    if (!config) {
      logInfo('No configuration found for platform RingHKSV')
      return
    }

    config.cameraStatusPollingSeconds = config.cameraStatusPollingSeconds ?? 20
    config.locationModePollingSeconds = config.locationModePollingSeconds ?? 20

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching')
      if (hasUsableRefreshToken(config.refreshToken)) {
        this.connectToApi().catch((e) => {
          this.log.error('Error connecting to API')
          this.log.error(e)
        })
      } else if (config.refreshToken) {
        this.log.warn(
          'Refresh token appears to be a placeholder. Skipping Ring API connection until a valid token is configured.',
        )
      } else {
        this.log.warn(
          'Plugin is not configured. See the standalone README for homebridge-ring-hksv setup instructions.',
        )
      }
    })

    this.homebridgeAccessories = {}
  }

  configureAccessory(accessory: PlatformAccessory) {
    logInfo(
      `Configuring cached accessory ${accessory.UUID} ${accessory.displayName}`,
    )
    this.log.debug('%j', accessory)
    this.homebridgeAccessories[accessory.UUID] = accessory
  }

  async connectToApi() {
    const [{ RingApi }, { Beam }, { Camera }, { SecurityPanel }, { Thermostat }] =
      await Promise.all([
        import('ring-client-api'),
        import('./beam.ts'),
        loadCameraAccessoryClass().then((Camera) => ({ Camera })),
        import('./security-panel.ts'),
        import('./thermostat.ts'),
      ])

    const { api, config } = this,
      systemId = getSystemId(api.user.storagePath()),
      ringApi = new RingApi({
        controlCenterDisplayName,
        ...config,
        systemId,
      }),
      locations = await ringApi.getLocations(),
      cachedAccessoryIds = Object.keys(this.homebridgeAccessories),
      platformAccessories: PlatformAccessory[] = [],
      externalAccessories: PlatformAccessory[] = [],
      activeAccessoryIds: string[] = []

    logInfo('Found the following locations:')

    locations.forEach((location) => {
      logInfo(`  locationId: ${location.id} - ${location.name}`)
    })

    const getLoadedAccessoryClass = (
      device: RingDevice,
    ): AccessoryClass | null => {
      const accessoryClass = getAccessoryClass(device)

      if (
        accessoryClass !== 'beam' &&
        accessoryClass !== 'security-panel' &&
        accessoryClass !== 'thermostat'
      ) {
        return accessoryClass
      }

      switch (accessoryClass) {
        case 'beam':
          return Beam as AccessoryClass
        case 'thermostat':
          return Thermostat as AccessoryClass
        case 'security-panel':
          return SecurityPanel as AccessoryClass
        default:
          return null
      }
    }

    await Promise.all(
      locations.map(async (location) => {
        const devices = await location.getDevices(),
          { cameras, chimes, intercoms } = location,
          securityPanel = devices.find(
            (x) => x.deviceType === RingDeviceType.SecurityPanel,
          ),
          debugPrefix = debug ? 'TEST ' : '',
          hapDevices = [
            ...devices.map((device) => ({
              deviceType: device.deviceType as string,
              device: device as any,
              isCamera: false,
              id: device.id.toString(),
              name: device.name,
              AccessoryClass: getLoadedAccessoryClass(device),
            })),
            ...cameras.map((device) => ({
              deviceType: device.deviceType as string,
              device: device as any,
              isCamera: true,
              id:
                device.id.toString() +
                'camera' +
                (config.externalCameraIdSalt
                  ? `-${config.externalCameraIdSalt}`
                  : ''),
              name: device.name,
              AccessoryClass: Camera,
            })),
            ...chimes.map((device) => ({
              deviceType: device.deviceType as string,
              device: device as any,
              isCamera: false,
              id: device.id.toString(),
              name: device.name,
              AccessoryClass: Chime,
            })),
            ...intercoms.map((device) => ({
              deviceType: device.deviceType as string,
              device: device as any,
              isCamera: false,
              id: device.id.toString(),
              name: device.name,
              AccessoryClass: Intercom,
            })),
          ],
          hideDeviceIds = config.hideDeviceIds || [],
          onlyDeviceTypes = config.onlyDeviceTypes?.length
            ? config.onlyDeviceTypes
            : undefined

        if (config.showPanicButtons && securityPanel) {
          hapDevices.push({
            deviceType: securityPanel.deviceType,
            device: securityPanel,
            isCamera: false,
            id: securityPanel.id.toString() + 'panic',
            name: 'Panic Buttons',
            AccessoryClass: PanicButtons,
          })
        }

        if (
          config.locationModePollingSeconds &&
          (await location.supportsLocationModeSwitching())
        ) {
          hapDevices.push({
            deviceType: 'location.mode',
            device: location,
            isCamera: false,
            id: location.id + 'mode',
            name: location.name + ' Mode',
            AccessoryClass: LocationModeSwitch,
          })
        }

        logInfo(
          `Configuring ${cameras.length} cameras and ${hapDevices.length} devices for location "${location.name}" - locationId: ${location.id}`,
        )
        hapDevices.forEach(
          ({ deviceType, device, isCamera, id, name, AccessoryClass }) => {
            const uuid = hap.uuid.generate(debugPrefix + id),
              displayName = debugPrefix + name

            if (
              !AccessoryClass ||
              (config.hideLightGroups &&
                deviceType === RingDeviceType.BeamsLightGroupSwitch) ||
              hideDeviceIds.includes(uuid) ||
              (onlyDeviceTypes && !onlyDeviceTypes.includes(deviceType))
            ) {
              if (!ignoreHiddenDeviceTypes.includes(deviceType)) {
                logInfo(`Hidden accessory ${uuid} ${deviceType} ${displayName}`)
              }
              return
            }

            if (isCamera && this.homebridgeAccessories[uuid]) {
              // Camera was previously bridged.  Remove it from the platform so that it can be added as an external accessory
              this.log.warn(
                `Camera ${displayName} was previously bridged. You will need to manually pair it as a new accessory.`,
              )
              this.api.unregisterPlatformAccessories(pluginName, platformName, [
                this.homebridgeAccessories[uuid],
              ])
              delete this.homebridgeAccessories[uuid]
            }

            const createHomebridgeAccessory = () => {
                const accessory = new api.platformAccessory(
                  displayName,
                  uuid,
                  isCamera
                    ? hap.Categories.CAMERA
                    : hap.Categories.SECURITY_SYSTEM,
                )

                if (isCamera) {
                  logInfo(
                    `Configured camera ${uuid} ${deviceType} ${displayName}`,
                  )
                  externalAccessories.push(accessory)
                } else {
                  logInfo(
                    `Adding new accessory ${uuid} ${deviceType} ${displayName}`,
                  )
                  platformAccessories.push(accessory)
                }

                return accessory
              },
              homebridgeAccessory =
                this.homebridgeAccessories[uuid] || createHomebridgeAccessory(),
              accessory = new AccessoryClass(
                device as any,
                homebridgeAccessory,
                config,
              )
            accessory.initBase()

            this.homebridgeAccessories[uuid] = homebridgeAccessory
            activeAccessoryIds.push(uuid)
          },
        )
      }),
    )

    if (platformAccessories.length) {
      api.registerPlatformAccessories(
        pluginName,
        platformName,
        platformAccessories,
      )
    }

    if (externalAccessories.length) {
      api.publishExternalAccessories(pluginName, externalAccessories)
    }

    const staleAccessories = cachedAccessoryIds
      .filter((cachedId) => !activeAccessoryIds.includes(cachedId))
      .map((id) => this.homebridgeAccessories[id])

    staleAccessories.forEach((staleAccessory) => {
      logInfo(
        `Removing stale cached accessory ${staleAccessory.UUID} ${staleAccessory.displayName}`,
      )
    })

    if (staleAccessories.length) {
      this.api.unregisterPlatformAccessories(
        pluginName,
        platformName,
        staleAccessories,
      )
    }

    ringApi.onRefreshTokenUpdated.subscribe(
      ({ oldRefreshToken, newRefreshToken }) => {
        if (!oldRefreshToken) {
          return
        }

        updateHomebridgeConfig(this.api, (configContents) => {
          return configContents.replace(oldRefreshToken, newRefreshToken)
        })
      },
    )
  }
}
