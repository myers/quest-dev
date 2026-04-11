---
title: Cast 2.0 Protocol Documentation
layout: default
---

# Cast 2.0 Protocol Documentation

Cast 2.0 is the binary protocol used by Meta Quest headsets for wireless video casting. It layers MGIK message framing inside XRSP transport frames, carrying H.264 video, pose data, input forwarding, and control commands over TCP.

This documentation covers the protocol wire format, message types, and known capabilities.

## Reference

- [Cast 2.0 Protocol Reference](protocol.md) — Wire format, handshake sequence, message types
- [MQDH Feature Flags](feature-flags.md) — Feature flag reference for Meta Quest Developer Hub
- [Unsupported Capabilities](open-investigations.md) — Audio, panel streaming, WiFi casting, and other known but unimplemented features

## Package

The TypeScript implementation is available as [`@myerscarpenter/cast2-protocol`](https://www.npmjs.com/package/@myerscarpenter/cast2-protocol) on npm.

```bash
npm install @myerscarpenter/cast2-protocol
```
