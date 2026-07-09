import { hap } from './hap.ts'
import type { RingPlatformConfig } from './config.ts'
import type { RingCamera } from 'ring-client-api'
import { BaseDataAccessory } from './base-data-accessory.ts'
import {
  catchError,
  exhaustMap,
  filter,
  map,
  mergeMap,
  share,
  switchMap,
  throttleTime,
} from 'rxjs/operators'
import { CameraSource } from './camera-source.ts'
import type { PlatformAccessory } from 'homebridge'
import { TargetValueTimer } from './target-value-timer.ts'
import { delay, logError, logInfo } from 'ring-client-api/util'
import { EMPTY, firstValueFrom, from, merge, of, timer } from 'rxjs'
import type { Observable } from 'rxjs'

export class Camera extends BaseDataAccessory<RingCamera> {
  private inHomeDoorbellStatus: boolean | undefined
  private cameraSource

  public readonly device
  public readonly accessory
  public readonly config

  constructor(
    device: RingCamera,
    accessory: PlatformAccessory,
    config: RingPlatformConfig,
  ) {
    super()

    this.device = device
    this.accessory = accessory
    this.config = config
    this.cameraSource = new CameraSource(this.device, this.config)

    if (!hap.CameraController) {
      const error =
        'HAP CameraController not found.  Please make sure you are on homebridge version 1.0.0 or newer'
      logError(error)
      throw new Error(error)
    }

    const { Characteristic, Service } = hap,
      { ChargingState, StatusLowBattery } = Characteristic

    accessory.configureController(this.cameraSource.controller)

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

    if (!config.hideCameraMotionSensor) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.MotionDetected,
        serviceType: Service.MotionSensor,
        onValue: this.getMotionDetectedObservable().pipe(
          switchMap((motion) => {
            if (!motion) {
              return Promise.resolve(false)
            }

            return this.loadSnapshotForEvent('Detected Motion', true)
          }),
        ),
      })
    }

    if (device.isDoorbot) {
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.ProgrammableSwitchEvent,
        serviceType: Service.Doorbell,
        onValue: device.onDoorbellPressed.pipe(
          throttleTime(15000),
          switchMap(() => {
            return this.loadSnapshotForEvent(
              'Doorbell Pressed',
              Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
            )
          }),
        ),
      })

      if (!config.hideDoorbellSwitch) {
        this.registerObservableCharacteristic({
          characteristicType: Characteristic.ProgrammableSwitchEvent,
          serviceType: Service.StatelessProgrammableSwitch,
          onValue: device.onDoorbellPressed.pipe(
            map(() => Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS),
          ),
        })

        // Hide long and double press events by setting max value
        this.getService(Service.StatelessProgrammableSwitch)
          .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
          .setProps({
            maxValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
          })
      }
    }

    if (device.hasLight && !config.hideCameraLight) {
      const lightTargetTimer = new TargetValueTimer<boolean>()
      this.registerCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Lightbulb,
        getValue: (data) => {
          const value = lightTargetTimer.hasTarget()
            ? lightTargetTimer.getTarget()
            : data.led_status === 'on'

          return value
        },
        setValue: (value: boolean) => {
          // Allow 30 seconds for the light value to update in our status updates from Ring
          lightTargetTimer.setTarget(value, 30000)
          return device.setLight(value)
        },
        requestUpdate: () => device.requestUpdate(),
      })
    }

    if (device.hasSiren && !config.hideCameraSirenSwitch) {
      this.registerCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Switch,
        serviceSubType: 'Siren',
        name: device.name + ' Siren',
        getValue: (data) => {
          return Boolean(
            data.siren_status && data.siren_status.seconds_remaining,
          )
        },
        setValue: (value) => device.setSiren(value),
        requestUpdate: () => device.requestUpdate(),
      })
    }

    if (device.hasInHomeDoorbell && !config.hideInHomeDoorbellSwitch) {
      this.device.onInHomeDoorbellStatus.subscribe(
        (data: boolean | undefined) => {
          this.inHomeDoorbellStatus = data
        },
      )
      this.registerObservableCharacteristic({
        characteristicType: Characteristic.On,
        serviceType: Service.Switch,
        serviceSubType: 'In-Home Doorbell',
        name: device.name + ' In-Home Doorbell',
        onValue: device.onInHomeDoorbellStatus,
        setValue: (value) => device.setInHomeDoorbell(value),
        requestUpdate: () => device.requestUpdate(),
      })
    }

    this.registerCharacteristic({
      characteristicType: Characteristic.Manufacturer,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => {
        if ('metadata' in data && 'third_party_manufacturer' in data.metadata) {
          return data.metadata.third_party_manufacturer
        }
        return 'Ring'
      },
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.Model,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => {
        if ('metadata' in data && 'third_party_model' in data.metadata) {
          return data.metadata.third_party_model
        }
        return `${device.model} (${data.kind})`
      },
    })
    this.registerCharacteristic({
      characteristicType: Characteristic.SerialNumber,
      serviceType: Service.AccessoryInformation,
      getValue: (data) => data.device_id,
    })

    if (device.hasBattery) {
      this.registerCharacteristic({
        characteristicType: Characteristic.StatusLowBattery,
        serviceType: Service.Battery,
        getValue: () => {
          return device.hasLowBattery
            ? StatusLowBattery.BATTERY_LEVEL_LOW
            : StatusLowBattery.BATTERY_LEVEL_NORMAL
        },
      })

      this.registerCharacteristic({
        characteristicType: Characteristic.ChargingState,
        serviceType: Service.Battery,
        getValue: () => {
          return device.isCharging
            ? ChargingState.CHARGING
            : ChargingState.NOT_CHARGING
        },
      })

      this.registerObservableCharacteristic({
        characteristicType: Characteristic.BatteryLevel,
        serviceType: Service.Battery,
        onValue: device.onBatteryLevel.pipe(
          map((batteryLevel) => {
            return batteryLevel === null ? 100 : batteryLevel
          }),
        ),
      })
    }
  }

  private getMotionDetectedObservable(): Observable<boolean> {
    const pollSeconds = Math.max(this.config.cameraStatusPollingSeconds ?? 20, 10),
      startedAt = Date.now() - 5000,
      seenEventIds = new Set<string>(),
      pushMotionEvents = this.device.onMotionDetected,
      enableMotionHistoryFallback =
        this.config.enableCameraMotionHistory !== false
    let historyFailureCount = 0
    let nextHistoryPollAt = 0
    const baseHistoryRetryMs = Math.max(pollSeconds * 1000, 30_000),
      polledNewMotionEvents = timer(pollSeconds * 1000, pollSeconds * 1000).pipe(
        exhaustMap(() => {
          if (Date.now() < nextHistoryPollAt) {
            return EMPTY
          }

          return from(
            this.device.getEvents({
              limit: 10,
              kind: 'motion',
            }),
          ).pipe(
            mergeMap(({ events }) => {
              historyFailureCount = 0
              nextHistoryPollAt = 0
              const newMotionEvents = events
                .filter((event) => {
                  const eventId = event.ding_id_str || String(event.ding_id)

                  return (
                    event.kind === 'motion' &&
                    Date.parse(event.created_at) >= startedAt &&
                    !seenEventIds.has(eventId)
                  )
                })
                .sort(
                  (a, b) =>
                    Date.parse(a.created_at) - Date.parse(b.created_at),
                )

              newMotionEvents.forEach((event) => {
                seenEventIds.add(event.ding_id_str || String(event.ding_id))
              })

              if (!newMotionEvents.length) return EMPTY

              logInfo(
                `${this.device.name} Detected Motion from Ring event history fallback`,
              )
              return of(true)
            }),
            catchError(() => {
              historyFailureCount++
              const retryDelayMs = Math.min(
                5 * 60 * 1000,
                baseHistoryRetryMs * 2 ** Math.min(historyFailureCount - 1, 4),
              )
              nextHistoryPollAt = Date.now() + retryDelayMs
              logError(
                `${this.device.name} failed to poll Ring event history for motion fallback; retrying in ${Math.ceil(retryDelayMs / 1000)} seconds`,
              )
              return EMPTY
            }),
          )
        }),
        // The false timer below has a second subscriber. Sharing keeps one
        // history request per poll instead of duplicating Ring API traffic.
        share(),
      ),
      polledMotionEvents = merge(
        polledNewMotionEvents,
        polledNewMotionEvents.pipe(
          switchMap(() => timer(65000).pipe(map(() => false))),
        ),
      )

    if (!enableMotionHistoryFallback) {
      return pushMotionEvents
    }

    this.device.onNewNotification.subscribe((notification) => {
      const dingId = notification.data?.event?.ding?.id

      if (dingId) {
        seenEventIds.add(String(dingId))
      }
    })

    return merge(pushMotionEvents, polledMotionEvents)
  }

  private async loadSnapshotForEvent<T>(
    eventDescription: string,
    characteristicValue: T,
  ) {
    let imageUuid = this.device.latestNotificationSnapshotUuid

    /**
     * Battery cameras may receive an initial notification with no image uuid,
     * followed shortly by a second notification with the image uuid. We need to
     * wait for the second notification before we can load the snapshot.
     */
    if (!this.device.canTakeSnapshotWhileRecording && !imageUuid) {
      await Promise.race([
        firstValueFrom(
          this.device.onNewNotification.pipe(
            filter((notification) => Boolean(notification.img?.snapshot_uuid)),
          ),
        ),
        // wait up to 2 seconds for the second notification
        delay(2000),
      ])
      imageUuid = this.device.latestNotificationSnapshotUuid

      if (!imageUuid) {
        // did not receive an image uuid and one can't be taken while recording. Proceed without a snapshot
        logInfo(this.device.name + ' ' + eventDescription)
        return characteristicValue
      }
    }

    logInfo(
      this.device.name +
        ` ${eventDescription}. Loading snapshot before sending event to HomeKit`,
    )

    try {
      await this.cameraSource.loadSnapshot(imageUuid)
    } catch {
      logInfo(
        this.device.name +
          ' Failed to load snapshot.  Sending event to HomeKit without new snapshot',
      )
    }

    return characteristicValue
  }
}
