---
title: Unsupported Capabilities
layout: default
---

# Unsupported Capabilities

Cast 2.0 supports more than video and pose. These are protocol capabilities that are known to exist but are **not yet implemented** in this package or in quest-dev.

---

## Audio Streaming

The protocol carries audio alongside video. The Quest initializes its audio capture pipeline on every casting session but produces no output until the host explicitly enables it.

**Protocol support:**
- 48 kHz, stereo, 16-bit PCM (uncompressed)
- Two independent sources: app/system audio and microphone, mixed before transmission
- Host sends `SetAudioState(1)` (MUD type 503) to enable app audio
- Host sends `SetMicAudioState(1)` (MUD type 505) to enable microphone
- Mic requires the `magic_casting:support_mic_audio` server feature flag
- AudioSegment wire format: `i32(type=102) + i32(layerId) + i64(timestamp_us) + PCM payload`
- Read buffer is 7680 bytes (1920 samples per read)
- Default bitrate 160kbps, latency target 50ms

**Open questions:**
- What's the actual PCM frame size per packet?
- Is there a handshake or does audio just start flowing after `SetAudioState(1)`?
- Can app audio and mic be enabled independently?
- What latency is achievable over TCP?

---

## Panel Streaming

Panel streaming is a separate mode from eye buffer casting. Instead of streaming the VR compositor output, it streams individual 2D panel apps as separate layers, each with its own VirtualDisplay and input device.

**Protocol support:**
- Activated via broadcast intent: `com.oculus.magicislandcastingservice.ENABLE_PANEL_STREAMING`
- Deactivated via: `com.oculus.magicislandcastingservice.DISABLE_PANEL_STREAMING`
- Creates per-panel VirtualDevice (VirtualDisplay + VirtualMouse + VirtualKeyboard)
- Each 2D app gets a VOLUMETRIC_WINDOW(3) LayerConfig with name `{token}.{packageName}`
- CursorEvent input routes through VirtualDevice API, bypassing the normal InputFrameOverride path
- Requires the `panel_streaming` feature flag

**Open questions:**
- Does enabling panel streaming during an active cast session work?
- What LayerConfig messages appear on the wire?
- Does the video stream change (resolution, format, multiple streams)?
- Does CursorEvent produce actual clicks in panel apps?
- Is ActivateLayer (301) needed to select which panel to stream?
- Can panel streaming and eye buffer casting coexist?

---

## WiFi Casting (No ADB Tunnel)

All current implementations use ADB USB tunneling (`adb reverse tcp:4445 tcp:4445`). The protocol also supports casting over WiFi.

**Open questions:**
- Does WiFi casting use the same protocol or add TLS?
- Is there a discovery/pairing phase before the TCP connection?
- Same port (4445) or different?
- Does MQDH use mDNS or another service discovery mechanism?

---

## Congestion Control

The protocol includes a congestion control system with configurable parameters. Not yet tested.

**Known properties (configurable via SetProperty):**
- `congestionControlWindow`: 1.0s
- `congestionControlDecreaseThreshold`: 2.0
- `congestionControlIncreaseThreshold`: 1.2
- `congestionControlMultiplicativeDecrease`: 0.85
- `congestionControlAdditiveIncrease`: 250,000 bits/sec
- `captureEncoderBitrate`: 40,000,000 bits/sec (40Mbps default)

**Open questions:**
- How does the Quest signal congestion to the host?
- Does adjusting these properties via SetProperty change stream quality?
- Is the encoder bitrate dynamically reduced under load?

---

## FOV Adjustment

Two commands carry FOV-related fields.

**Protocol support:**
- `SetDeviceEyeFovConfig(inward, outward, up, down)` — 4 i32 params
- `UpdateCastingConfig` includes a `fovAdjustment` float field
- All zeros = use device defaults

**Open questions:**
- What visible effect does changing FOV have on the stream?
- Are the units degrees or radians?
- Does FOV adjustment change resolution or just crop?

---

## Image Stabilization

`UpdateCastingConfig` has an `imageStabilizationMode` field (defaults to 0). Related to the `image_stabilization` feature flag.

**Open questions:**
- What values are valid?
- What does stabilization mean in a VR casting context?
- Does enabling it affect latency?

---

## Lifecycle Commands

Three empty-payload MUD messages exist for development tooling:

| MUD Type | Command | Description |
|----------|---------|-------------|
| 500 | ReloadApp | Reload the casting service runtime |
| 502 | ToggleInspector | Toggle performance overlay |
| 504 | OpenDebugger | Open debugger port |

Not used by any known host implementation.

---

## Dialog System

MUD types for a dialog system exist but are not used during normal casting:

| MUD Type | Command |
|----------|---------|
| 400 | ShowDialog |
| 401 | DialogButtonPress |
| 402 | SystemDialogResult |

Likely triggered by error conditions or permission prompts during casting.

---

## Tracking Mode Control

`setTrackingMode(int32 mode)` accepts mode values 0-255. Effects on the tracking system are unknown.

**Open questions:**
- What do different mode values do?
- Is there a mode that disables head tracking?
- Does this interact with the pose injection pipeline?
