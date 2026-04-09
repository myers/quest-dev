# @myerscarpenter/cast2-protocol

Pure TypeScript implementation of the Meta Quest **Cast 2.0** binary protocol — XRSP framing, MGIK sub-headers, MUD message builders/parsers, pose math, and resolution presets.

Zero runtime dependencies. Works in Node.js ≥ 18.

## Install

```bash
npm install @myerscarpenter/cast2-protocol
```

## Quick Start

```typescript
import {
  packXrsp,
  packMgikSub,
  buildInit,
  buildPose,
  buildConfig,
  createPoseState,
  updatePose,
  CAST_PORT,
  RESOLUTIONS,
} from "@myerscarpenter/cast2-protocol";

// Build an INIT command
const subMagic = 0xdeadbeef; // learned from Quest's first message
const payload = buildInit(subMagic, /* seq */ 0);
const frame = packXrsp(/* seq */ 0, payload);

// Pose management
let pose = createPoseState();
pose = updatePose(pose, { dYaw: 0.5, dForward: 1.0 });
const posePayload = buildPose(subMagic, 1, pose);
```

## API Overview

### XRSP (framing layer)
- `packXrsp(seq, payload, flags?, topic?)` — pack an XRSP frame
- `parseXrspHeader(data)` — parse 8-byte XRSP header
- `xrspPayloadSize(header)` — compute payload size from header

### MGIK (sub-header)
- `packMgikSub(subMagic, msgSeq)` — pack 24-byte MGIK sub-header
- `parseMgikSub(data)` — parse MGIK sub-header
- `detectSubMagic(payload)` — detect sub_magic from Quest's initial message
- `isMgikMagic(payload)` — check for "MGIK" magic bytes

### MUD (message builders)
- `buildInit`, `buildConfig`, `buildKeepalive`, `buildShortAck`
- `buildPose`, `buildDisplayConfig`, `buildDisconnect`
- `buildSetProperty`, `buildVirtualMouse`
- `buildInputForwardingState`, `buildStartInputForwarding`, `buildActivateLayer`
- `buildMud` — arbitrary MUD message
- `parseLayerConfiguration` — parse LayerConfiguration responses
- `packMudString` / `parseMudString` — length-prefixed string encoding

### Pose Math
- `createPoseState()` — identity pose at origin
- `eulerToQuat(yaw, pitch)` — euler angles to quaternion
- `updatePose(state, delta)` — apply incremental movement
- `setPoseOffset(state, offset)` — set absolute offset
- `screenToYawPitch(x, y, ...)` — screen coordinates to yaw/pitch

### Resolutions
- `RESOLUTIONS` — preset map (`720p`, `1080p`, `native`)
- `resolveResolution(name?, width?, height?)` — resolve to width/height

### Constants
All protocol constants are exported: `CAST_PORT`, `QUEST_CAST_PORT`, `XRSP_HEADER_SIZE`, `MGIK_MAGIC`, command IDs (`CMD_POSE`, `CMD_INIT`, etc.), eye selectors (`EYE_LEFT`, `EYE_RIGHT`, `EYE_STEREO`), layer types, and more.

### Types
- `XrspHeader`, `MgikSubHeader`, `LayerInfo`
- `PoseState`, `PoseDelta`, `PoseOffset`
- `Resolution`

## Documentation

Full protocol documentation is available at [myers.github.io/quest-dev](https://myers.github.io/quest-dev/).

## License

MIT
