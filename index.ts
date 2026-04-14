import type { API } from 'homebridge'
import { platformName, RingPlatform } from './ring-platform.ts'
import { setHap } from './hap.ts'

export default function (api: API) {
  setHap(api.hap)
  api.registerPlatform(platformName, RingPlatform)
}
