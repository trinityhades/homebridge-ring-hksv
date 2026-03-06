<p align="center">
  <a href="https://github.com/homebridge/verified/blob/master/verified-plugins.json"><img alt="Homebridge Verified" src="https://raw.githubusercontent.com/dgreif/ring/main/packages/homebridge-ring/branding/Homebridge_x_Ring.svg?sanitize=true" width="500px"></a>
</p>

# homebridge-ring-hksv

[![npm](https://badgen.net/npm/v/homebridge-ring-hksv)](https://www.npmjs.com/package/homebridge-ring-hksv)
[![npm](https://badgen.net/npm/dt/homebridge-ring-hksv)](https://www.npmjs.com/package/homebridge-ring-hksv)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/unverified)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![certified-hoobs-plugin](https://badgen.net/badge/HOOBS/Uncertified/yellow)](https://plugins.hoobs.org/plugin/homebridge-ring-hksv)
[![Donate](https://badgen.net/badge/Donate/BuyMeACoffee/FFDD00)](https://buymeacoffee.com/trinityhades)

# homebridge-ring-hksv

`homebridge-ring-hksv` is a Homebridge platform plugin for Ring devices, with HomeKit Secure Video (HKSV) support.

## Origin and Attribution

This project is based on Dustin Greif's original Ring Homebridge ecosystem:

- Upstream plugin: `dgreif/homebridge-ring`
- Upstream API library: `dgreif/ring-client-api`

Big thanks to Dustin and all upstream contributors. This fork reuses and extends that foundation.

## What This Plugin Does

This plugin integrates Ring locations and devices into HomeKit via Homebridge, including:

- Ring cameras and doorbells
- Ring Alarm devices and sensors
- Ring chimes and intercoms
- Ring Smart Lighting and supported alarm-connected devices
- Thermostats, locks, outlets/switches, valves, and other supported accessory types

It also introduces HKSV-focused controls such as:

- `enableHksv`
- `disableHksvOnBattery`
- `hksvPrebufferLengthMs`
- `hksvFragmentLengthMs`
- `hksvMaxRecordingSeconds`

## How This Fork Differs From Upstream

This fork is intended as a standalone package/repository with your own plugin identity and HKSV-focused iteration.

In short:

- Standalone plugin packaging
- Custom branding/repository ownership
- Additional HKSV recording controls exposed in config

Core Ring platform behavior still relies on `ring-client-api`, so many upstream troubleshooting guides remain relevant.

## Installation

If Homebridge is installed globally:

```bash
npm i -g --unsafe-perm homebridge-ring-hksv
```

If running from source:

```bash
npm install
npm run build
```

## Basic Configuration

Use Homebridge UI (`homebridge-config-ui-x`) when possible.

Add a platform block with your Ring refresh token:

```json
{
  "platform": "RingHKSV",
  "refreshToken": "your-refresh-token"
}
```

## Important Options

| Option | Purpose |
| --- | --- |
| `enableHksv` | Enables experimental HKSV support for eligible cameras |
| `disableHksvOnBattery` | Disables HKSV on battery cameras to reduce battery/network usage |
| `hksvPrebufferLengthMs` | HKSV prebuffer duration (minimum 4000ms) |
| `hksvFragmentLengthMs` | HKSV fragment duration target |
| `hksvMaxRecordingSeconds` | Optional safety cap for a recording session |
| `cameraVideoCodec` | Preferred H.264 encoder (`h264_videotoolbox` or `libx264`) |
| `hideDoorbellSwitch` / `hideCameraMotionSensor` / `hideCameraSirenSwitch` | Hides specific HomeKit-exposed services |
| `showPanicButtons` | Adds panic switches (use with caution) |
| `ffmpegPath` | Override FFmpeg binary path |
| `debug` | Enables additional logging |
| `disableLogs` | Disables plugin logging |

## HKSV Status

HKSV support is experimental and actively evolving. Behavior may vary by camera model, wired vs battery power, Ring API changes, and FFmpeg environment.

## Troubleshooting

For support and debugging:

- This repository issues: <https://github.com/trinityhades/homebridge-ring-hksv/issues>
- Upstream Ring wiki (token/auth/camera references): <https://github.com/dgreif/ring/wiki>

## Disclaimer

This plugin is not affiliated with Ring or Amazon.

Use emergency/panic-related automations at your own risk.

## License

MIT
