<p align="center">
  <a href="https://github.com/homebridge/verified/blob/master/verified-plugins.json"><img alt="Homebridge Verified" src="https://raw.githubusercontent.com/dgreif/ring/main/packages/homebridge-ring/branding/Homebridge_x_Ring.svg?sanitize=true" width="500px"></a>
</p>

# homebridge-ring-hksv

[![npm](https://badgen.net/npm/v/homebridge-ring-hksv)](https://www.npmjs.com/package/homebridge-ring-hksv)
[![npm](https://badgen.net/npm/dt/homebridge-ring-hksv)](https://www.npmjs.com/package/homebridge-ring-hksv)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/unverified)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![certified-hoobs-plugin](https://badgen.net/badge/HOOBS/Uncertified/yellow)](https://plugins.hoobs.org/plugin/homebridge-ring-hksv)
[![Donate](https://badgen.net/badge/Donate/BuyMeACoffee/FFDD00)](https://buymeacoffee.com/trinityhades)


`homebridge-ring-hksv` is a Homebridge platform plugin for Ring devices, with HomeKit Secure Video (HKSV) support.

## Origin and Attribution

This project is based on Dustin Greif's original Ring Homebridge ecosystem:

- Upstream plugin: [dgreif/homebridge-ring](https://github.com/dgreif/homebridge-ring)
- Upstream API library: [dgreif/ring-client-api](https://github.com/dgreif/ring-client-api)

Big thanks to Dustin and all upstream contributors. This fork reuses and extends that foundation.

## Important Plugin Options

| Option | Purpose |
| --- | --- |
| `enableHksv` | Enables experimental HKSV support for eligible cameras |
| `disableHksvOnBattery` | Disables HKSV on battery cameras to reduce battery/network usage |
| `hksvPrebufferLengthMs` | HKSV prebuffer duration (minimum 4000ms) |
| `hksvFragmentLengthMs` | HKSV fragment duration target |
| `hksvMaxRecordingSeconds` | Optional safety cap for a recording session |
| `hksvPerformanceMode` | HKSV tuning profile (`balanced`, `rpi`, or `quality`) |
| `hksvMaxConcurrentRecordings` / `hksvMaxQueuedBytes` | HKSV safeguards for small systems under load |
| `hksvVideoBitrateKbps` / `hksvVideoMaxBitrateKbps` / `hksvVideoBufferSizeKbps` | HKSV recording bitrate controls for improving fast-motion quality |
| `hksvVideoCrf` / `hksvVideoPreset` | Optional libx264 quality and CPU tuning controls |
| `hksvVideoKeyframeInterval` | HKSV recording keyframe interval |
| `homeKitAccessoryTag` | Appends a tag to accessory names and HomeKit IDs so the same Ring device can be exposed as a distinct HomeKit accessory for debugging/testing |
| `cameraVideoCodec` | Preferred H.264 handling (`auto`, `copy`, `h264_v4l2m2m`, `h264_videotoolbox`, or `libx264`) |
| `hideDoorbellSwitch` / `hideCameraMotionSensor` / `hideCameraSirenSwitch` | Hides specific HomeKit-exposed services |
| `showPanicButtons` | Adds panic switches (use with caution) |
| `ffmpegPath` | Override FFmpeg binary path |
| `debug` | Enables additional logging |
| `disableLogs` | Disables plugin logging |

## Installation

If Homebridge is installed globally:

```bash
npm i -g --unsafe-perm homebridge-ring-hksv
```

If you want an opt-in prerelease channel from npm, install one of the dist-tags instead:

```bash
npm i -g --unsafe-perm homebridge-ring-hksv@dev
npm i -g --unsafe-perm homebridge-ring-hksv@nightly
```

The `latest` tag remains the stable release line. `dev` is intended for hand-picked prerelease builds, and `nightly` is intended for newer automated or near-mainline snapshots.

If running from source:

```bash
npm install
npm run build
```

To publish an opt-in prerelease channel to npm:

```bash
npm run publish:dev
npm run publish:nightly
```

Both commands create a prerelease semver version and publish it under the matching npm dist-tag, so users can install `homebridge-ring-hksv@dev` or `homebridge-ring-hksv@nightly` without affecting `latest`. Add `-- --dry-run` to preview the computed version without changing files or publishing.

## Basic Configuration

Use Homebridge UI (`homebridge-config-ui-x`) when possible.

Add a platform block with your Ring refresh token:

```json
{
  "platform": "Homebridge Ring HKSV",
  "refreshToken": "your-refresh-token"
}
```

If you need Home app to treat the same physical Ring device as a different HomeKit accessory, add a `homeKitAccessoryTag`:

```json
{
  "platform": "Homebridge Ring HKSV",
  "refreshToken": "your-refresh-token",
  "homeKitAccessoryTag": "Debug Home A"
}
```

Changing `homeKitAccessoryTag` updates both the exposed accessory name and the generated HomeKit identity, which changes the advertised MAC-style identifier shown during manual camera pairing.

## HKSV Status

HKSV support is experimental and actively evolving. Behavior may vary by camera model, wired vs battery power, Ring API changes, and FFmpeg environment.

I currently am able to run 3 cameras with HKSV enabled on a Homebridge instance ran on a M4 Mac Mini 32GB of RAM.
Please report your experience and setup details to help improve support.

For fast-motion pixelation or stuttering in HKSV recordings, try increasing
`hksvVideoBitrateKbps` first if you are transcoding. On Apple Silicon Macs,
`cameraVideoCodec: "h264_videotoolbox"` can reduce CPU load by using hardware
encoding.

For Raspberry Pi 4/5 and other small computers, start with:

```json
{
  "enableHksv": true,
  "hksvPerformanceMode": "rpi",
  "cameraVideoCodec": "auto",
  "hksvMaxConcurrentRecordings": 1
}
```

The `rpi` profile favors remuxing Ring's H.264 video into HomeKit Secure Video
fragmented MP4 instead of re-encoding it. This is much lighter than libx264, but
it depends on Ring's current stream being compatible with HomeKit's H.264
recording requirements. If recording fails in this mode, try
`cameraVideoCodec: "h264_v4l2m2m"` when your FFmpeg build exposes that encoder,
or fall back to `cameraVideoCodec: "libx264"` with `hksvVideoPreset:
"ultrafast"`.

### Minimum specifications for HKSV: 
[TBD - will be added as more users test and report their setups]

## Troubleshooting

For support and debugging:

- This repository issues: <https://github.com/trinityhades/homebridge-ring-hksv/issues>

- Upstream Ring wiki (token/auth/camera references): <https://github.com/dgreif/ring/wiki>

## Disclaimer

This plugin is not affiliated with Ring or Amazon.

Use emergency/panic-related automations at your own risk.

## License

MIT
