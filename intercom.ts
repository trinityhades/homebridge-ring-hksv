import type { RingIntercom } from 'ring-client-api'
import { RingCamera } from 'ring-client-api'
import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import type { PlatformAccessory } from 'homebridge'
import { BaseDataAccessory } from './base-data-accessory.ts'
import { logError, logInfo } from 'ring-client-api/util'
import { map, throttleTime } from 'rxjs/operators'
import { Subject } from 'rxjs'
import { CameraSource } from './camera-source.ts'

/**
 * Creates a RingCamera-compatible proxy for a Ring Intercom Video device.
 * Ring Intercom Video is classified as RingIntercom by ring-client-api but has a
 * real camera. We use Object.create(RingCamera.prototype) so that startLiveCall()
 * and createStreamingConnection() are inherited and work with the intercom's
 * restClient and device id (Ring's signalling server uses the same doorbot_id
 * scheme for video intercoms as for cameras).
 */
function createIntercomVideoProxy(device: RingIntercom): RingCamera {
  const proxy = Object.create(RingCamera.prototype) as RingCamera

  // RingCamera defines several properties (e.g. `name`, `id`) as getter-only on its
  // prototype. Object.assign would try to set them via the prototype setter and throw.
  // Object.defineProperty defines own properties directly on the proxy instance,
  // shadowing the prototype getters without triggering them.
  const define = (key: string, value: unknown) =>
    Object.defineProperty(proxy, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    })

  define('id', device.id)
  define('name', device.name)
  define('deviceType', device.deviceType)
  define('data', {
    kind: device.deviceType,
    device_id: String(device.id),
    settings: {
      live_view_disabled: false,
      motion_detection_enabled: true,
    },
    metadata: {},
  })
  // restClient is technically private in TypeScript but public in compiled JS
  define('restClient', (device as any).restClient)
  define('isRingEdgeEnabled', false)
  define('hasBattery', device.batteryLevel !== null)
  define('isOffline', device.isOffline)
  define('snapshotsAreBlocked', false)
  define('hasSnapshotWithinLifetime', false)
  define('snapshotLifeTime', 10000)
  define('canTakeSnapshotWhileRecording', false)
  define('latestNotificationSnapshotUuid', undefined)
  define('onNewNotification', new Subject<never>())
  define('onMotionDetected', new Subject<boolean>())
  define('onDoorbellPressed', device.onDing)
  define('onBatteryLevel', device.onBatteryLevel)
  define('onInHomeDoorbellStatus', new Subject<boolean | undefined>())
  define('hasLowBattery', false)
  define('isCharging', false)
  define('isDoorbot', true)
  define('hasLight', false)
  define('hasSiren', false)
  define('hasInHomeDoorbell', false)
  define('model', 'Ring Intercom Video')
  // Override getSnapshot: intercom uses the same doorbots snapshot endpoint as cameras
  define('getSnapshot', async () => {
    try {
      return await (device as any).restClient.request({
        url: (device as any).doorbotUrl('snapshot'),
        responseType: 'buffer',
      })
    } catch {
      throw new Error(`Snapshot not available for ${device.name}`)
    }
  })

  return proxy
}

export class Intercom extends BaseDataAccessory<RingIntercom> {
  private unlocking = false
  private unlockTimeout?: ReturnType<typeof setTimeout>

  public readonly device
  public readonly accessory
  public readonly config

  constructor(
    device: RingIntercom,
    accessory: PlatformAccessory,
    config: RingPlatformConfig,
  ) {
    super()

    this.device = device
    this.accessory = accessory
    this.config = config

    const { Characteristic, Service } = hap,
      isIntercomVideo = device.deviceType === 'intercom_handset_video'

    // Set up camera streaming for Ring Intercom Video before other services
    if (isIntercomVideo) {
      const cameraProxy = createIntercomVideoProxy(device)
      const cameraSource = new CameraSource(cameraProxy, config)
      accessory.configureController(cameraSource.controller)

      this.registerCharacteristic({
        characteristicType: Characteristic.Mute,
        serviceType: Service.Microphone,
        getValue: () => false,
      })

      this.registerCharacteristic({
        characteristicType: Characteristic.Mute,
        serviceType: Service.Speaker,
        getValue: () => false,
      })

      logInfo(`Camera streaming enabled for Ring Intercom Video: ${device.name}`)
    }

    const lockService = this.getService(Service.LockMechanism),
      { LockCurrentState, LockTargetState, ProgrammableSwitchEvent } =
        Characteristic,
      programableSwitchService = this.getService(
        Service.StatelessProgrammableSwitch,
      ),
      onDoorbellPressed = device.onDing.pipe(
        throttleTime(15000),
        map(() => ProgrammableSwitchEvent.SINGLE_PRESS),
      ),
      syncLockState = () => {
        const state = this.getLockState()
        lockService
          .getCharacteristic(Characteristic.LockCurrentState)
          .updateValue(state)
        lockService
          .getCharacteristic(Characteristic.LockTargetState)
          .updateValue(state)
      },
      markAsUnlocked = () => {
        // Mark the lock as unlocked, wait 5 seconds, then mark it as locked again
        clearTimeout(this.unlockTimeout)
        this.unlocking = true

        // Update current state to reflect that the lock is unlocked
        syncLockState()

        // Leave the door in an "unlocked" state for 5 seconds
        // After that, set the lock back to "locked" for both current and target state
        this.unlockTimeout = setTimeout(() => {
          this.unlocking = false
          syncLockState()
        }, 5000)
      }

    // Subscribe to unlock events coming from push notifications, which will catch an unlock from the Ring app
    device.onUnlocked.subscribe(markAsUnlocked)

    // Lock Service
    this.registerCharacteristic({
      characteristicType: LockCurrentState,
      serviceType: lockService,
      getValue: () => this.getLockState(),
      requestUpdate: () => device.requestUpdate(),
    })
    this.registerCharacteristic({
      characteristicType: LockTargetState,
      serviceType: lockService,
      getValue: () => this.getLockState(),
      setValue: async (state: number) => {
        clearTimeout(this.unlockTimeout)

        if (state === LockTargetState.UNSECURED) {
          logInfo(`Unlocking ${device.name}`)
          this.unlocking = true

          const response = await device.unlock().catch((e) => {
            logError(e)
            this.unlocking = false
          })
          logInfo(`Unlock response: ${JSON.stringify(response)}`)

          markAsUnlocked()
        } else {
          // If the user locks the door from the home app, we can't do anything but set the states back to "locked"
          this.unlocking = false
          lockService
            .getCharacteristic(Characteristic.LockCurrentState)
            .updateValue(this.getLockState())
        }
      },
    })
    lockService.setPrimaryService(true)

    // Doorbell Service
    this.registerObservableCharacteristic({
      characteristicType: ProgrammableSwitchEvent,
      serviceType: Service.Doorbell,
      onValue: onDoorbellPressed,
    })

    // Programmable Switch Service
    this.registerObservableCharacteristic({
      characteristicType: ProgrammableSwitchEvent,
      serviceType: programableSwitchService,
      onValue: onDoorbellPressed,
    })

    // Hide long and double press events by setting max value
    programableSwitchService
      .getCharacteristic(ProgrammableSwitchEvent)
      .setProps({
        maxValue: ProgrammableSwitchEvent.SINGLE_PRESS,
      })

    // Battery Service
    if (device.batteryLevel !== null) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.BatteryLevel,
        serviceType: Service.Battery,
        onValue: device.onBatteryLevel.pipe(
          map((batteryLevel) => {
            return batteryLevel === null ? 100 : batteryLevel
          }),
        ),
        requestUpdate: () => device.requestUpdate(),
      })
    }

    // Accessory Information Service
    this.registerCharacteristic({
      characteristicType: Characteristic.Manufacturer,
      serviceType: Service.AccessoryInformation,
      getValue: () => 'Ring',
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.Model,
      serviceType: Service.AccessoryInformation,
      getValue: () =>
        isIntercomVideo ? 'Ring Intercom Video' : 'Ring Intercom',
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.SerialNumber,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => data.device_id || 'Unknown',
    })
  }

  private getLockState() {
    const {
      Characteristic: { LockCurrentState: State },
    } = hap
    return this.unlocking ? State.UNSECURED : State.SECURED
  }
}
