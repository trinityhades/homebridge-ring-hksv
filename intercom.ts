import type { RingIntercom } from 'ring-client-api'
import { RingCamera } from 'ring-client-api'
import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import type { PlatformAccessory } from 'homebridge'
import { BaseDataAccessory } from './base-data-accessory.ts'
import { logError, logInfo } from 'ring-client-api/util'
import { filter, map, share, switchMap, throttleTime } from 'rxjs/operators'
import { interval, merge, Subject } from 'rxjs'
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

  const defineValue = (key: string, value: unknown) =>
    Object.defineProperty(proxy, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    })
  const defineGetter = (key: string, get: () => unknown) =>
    Object.defineProperty(proxy, key, {
      get,
      configurable: true,
      enumerable: true,
    })

  defineValue('id', device.id)
  defineGetter('name', () => device.name)
  defineGetter('deviceType', () => device.deviceType)
  defineGetter('data', () => ({
    ...device.data,
    kind: device.deviceType,
    device_id: String(device.id),
    metadata: (device.data as any).metadata ?? {},
    settings: {
      live_view_disabled: false,
      motion_detection_enabled: true,
      ...(device.data as any).settings,
    },
  }))
  // restClient is technically private in TypeScript but public in compiled JS
  defineValue('restClient', (device as any).restClient)
  defineGetter('isRingEdgeEnabled', () => false)
  defineGetter('hasBattery', () => device.batteryLevel !== null)
  defineGetter('isOffline', () => device.isOffline)
  defineGetter('snapshotsAreBlocked', () => false)
  defineGetter('canTakeSnapshotWhileRecording', () => false)
  defineGetter('latestNotificationSnapshotUuid', () => undefined)
  defineValue('onNewNotification', new Subject<never>())
  defineValue('onMotionDetected', new Subject<boolean>())
  defineValue('onDoorbellPressed', device.onDing)
  defineValue('onBatteryLevel', device.onBatteryLevel)
  defineValue('onInHomeDoorbellStatus', new Subject<boolean | undefined>())
  defineGetter(
    'hasLowBattery',
    () => Boolean((device.data as any).alerts?.battery === 'low'),
  )
  defineGetter('isCharging', () => false)
  defineValue('isDoorbot', true)
  defineValue('hasLight', false)
  defineValue('hasSiren', false)
  defineValue('hasInHomeDoorbell', false)
  defineValue('model', 'Ring Intercom Video')
  defineValue('snapshotLifeTime', 55000) // camera stays active ~1 min after a ring
  // Pre-warm support: start the WebRTC call the moment a ding is detected so
  // the camera is already streaming when HKSV requests the recording.
  let preWarmedCall: Promise<any> | null = null
  let preWarmCleanup: ReturnType<typeof setTimeout> | null = null
  let lastSnapshotAt = 0

  const realStartLiveCall = () =>
    (RingCamera.prototype.startLiveCall as any).call(proxy)

  defineValue('startLiveCall', () => {
    if (preWarmedCall) {
      const call = preWarmedCall
      preWarmedCall = null
      if (preWarmCleanup) {
        clearTimeout(preWarmCleanup)
        preWarmCleanup = null
      }
      logInfo(`${device.name}: using pre-warmed camera session for recording`)
      return call
    }
    return realStartLiveCall()
  })

  defineValue('preWarmCamera', () => {
    if (preWarmedCall) return
    logInfo(`${device.name}: pre-warming camera connection`)
    preWarmedCall = realStartLiveCall()
    // Clean up if HKSV doesn't claim it within 20 seconds
    preWarmCleanup = setTimeout(async () => {
      if (preWarmedCall) {
        try {
          const session = await preWarmedCall
          session.stop()
        } catch (e) {
          logError(`Failed to stop pre-warmed camera session for ${device.name}`)
          logError(e)
        } finally {
          preWarmedCall = null
          preWarmCleanup = null
        }
      }
    }, 20000)
  })

  // Override getSnapshot: intercom uses the same doorbots snapshot endpoint as cameras.
  defineGetter(
    'hasSnapshotWithinLifetime',
    () => Date.now() - lastSnapshotAt < proxy.snapshotLifeTime,
  )
  defineValue('getSnapshot', async (_options?: { uuid?: string }) => {
    try {
      const snapshot = await (device as any).restClient.request({
        url: (device as any).doorbotUrl('snapshot'),
        responseType: 'buffer',
      })
      lastSnapshotAt = Date.now()
      return snapshot
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
    let intercomVideoProxy: RingCamera | null = null
    if (isIntercomVideo) {
      const cameraProxy = createIntercomVideoProxy(device)
      intercomVideoProxy = cameraProxy
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
      // Ring Intercom Video ding events may arrive as camera-style FCM push
      // notifications (different category than RingIntercom.onDing expects),
      // so onDing never fires. Poll Ring's active-dings endpoint as a reliable
      // fallback — it reflects the current ring in real time (unlike the history
      // endpoint which can lag by ~60 seconds).
      onDingDetected = (() => {
        if (!isIntercomVideo) {
          return device.onDing.pipe(share())
        }

        let lastDingId: string | undefined

        const polled = interval(3000).pipe(
          switchMap(async () => {
            try {
              const active: any[] = await (device as any).restClient.request({
                url: 'https://api.ring.com/clients_api/dings/active',
              })
              return Array.isArray(active) ? active : []
            } catch {
              return []
            }
          }),
          filter((active: any[]) => {
            const ding = active.find(
              (d) =>
                String(d.doorbot_id) === String(device.id) &&
                d.kind === 'ding',
            )
            if (!ding) return false
            if (String(ding.id) === lastDingId) return false
            lastDingId = String(ding.id)
            return true
          }),
          map(() => undefined as void),
        )

        // share() makes this hot: one polling interval, one lastDingId,
        // emission fans out to all subscribers that rely on ding events.
        return merge(device.onDing, polled).pipe(throttleTime(3000), share())
      })(),
      onDoorbellPressed = onDingDetected.pipe(
        throttleTime(15000),
        map(() => {
          logInfo(`Doorbell pressed on ${device.name} — sending HomeKit event`)
          return ProgrammableSwitchEvent.SINGLE_PRESS
        }),
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
    // For audio-only intercom the lock is the main function; for video intercom
    // the camera controller owns the primary-service role so HomeKit routes
    // doorbell events (and HomePod chimes) correctly.
    if (!isIntercomVideo) {
      lockService.setPrimaryService(true)
    }

    // Pre-warm the camera WebRTC connection on every ding so HKSV recording
    // gets live video instead of black frames.
    if (intercomVideoProxy) {
      const proxy = intercomVideoProxy
      onDingDetected.subscribe(() => {
        ;(proxy as any).preWarmCamera?.()
      })
    }

    // Doorbell Service
    this.registerObservableCharacteristic({
      characteristicType: ProgrammableSwitchEvent,
      serviceType: Service.Doorbell,
      onValue: onDoorbellPressed,
    })

    // Programmable Switch Service — only for audio-only intercom; the video
    // variant already exposes Service.Doorbell which covers this.
    if (!isIntercomVideo) {
      const programableSwitchService = this.getService(
        Service.StatelessProgrammableSwitch,
      )
      this.registerObservableCharacteristic({
        characteristicType: ProgrammableSwitchEvent,
        serviceType: programableSwitchService,
        onValue: onDoorbellPressed,
      })
      programableSwitchService
        .getCharacteristic(ProgrammableSwitchEvent)
        .setProps({
          maxValue: ProgrammableSwitchEvent.SINGLE_PRESS,
        })
    }

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
