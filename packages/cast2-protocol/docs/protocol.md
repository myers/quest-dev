---
title: Cast 2.0 Protocol Reference
layout: default
---

# Cast 2.0 Protocol Reference

Cast 2.0 (codename "Magic Island") is a compositor-level VR streaming protocol
used by Meta Quest headsets. It streams live H.264 video from the headset to a
desktop host, with support for remote pose injection, resolution control, and
input forwarding.

## Architecture

```
+------------------+        ADB/TCP         +---------------------+
|  Desktop Client  | <------ XRSP -------> |  Quest Headset      |
|  (quest-dev)     |      MGIK messages     |  (Casting Service)  |
+------------------+                        +---------------------+
       |                                           |
  H.264 decoder                            OpenXR Capture Layer
  + Web dashboard                          + H.264 HW Encoder
  + Pose controller                        + XRSP Participant
```

### Protocol Stack

```
┌─────────────────────────────┐
│  MUD Messages               │  Application layer
├─────────────────────────────┤
│  MGIK Sub-Header (24B)      │  Session framing
├─────────────────────────────┤
│  MGIK Header (8B)           │  Quest → Desktop only
├─────────────────────────────┤
│  XRSP Packet (8B header)    │  Transport framing
├─────────────────────────────┤
│  TCP                        │  Reliable delivery
└─────────────────────────────┘
```

## TCP Connections

Cast 2.0 uses two unidirectional TCP connections, both initiated by the Quest
to the desktop on port 4445:

| Connection | Direction | Carries | MGIK header? |
|---|---|---|---|
| Control (first SYN, lower source port) | Desktop → Quest | MUD commands | No |
| Video (second SYN, higher source port) | Quest → Desktop | Video, LayerConfig, ACKs | Yes |

The control connection can be identified because it does **not** carry MGIK
headers. The video connection can be identified by the TRANSPORT string sent
as its first message.

### TRANSPORT String

The first message on the video connection is a TRANSPORT identification string:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        0x00000001                             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      type (BE u32)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  string length (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    ASCII string data ...                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Example: `"tcpclient,localhost,4445"`

## XRSP Packet Format

Each XRSP packet consists of an 8-byte little-endian header followed by
a payload padded to 4-byte alignment.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     flags     |   topic_id    |       word_count (LE u16)     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|      sequence_number (LE u16) |         padding (LE u16)      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                      payload (variable)                       |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **flags**: `0x10` = standard, `0x18` = has alignment padding
- **topic_id**: always `2` for Cast 2.0
- **word_count**: total packet size = `word_count × 4` bytes
- **payload size**: `(word_count - 1) × 4` bytes

Cast 2.0 uses only topic 2 (Command) for all traffic — both video and control
flow through the same topic. This is simpler than Quest Link, which uses 34+
topics with Cap'n Proto serialization.

## MGIK Header (8 bytes, Quest → Desktop only)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|      'M'      |      'G'      |      'I'      |      'K'      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    version    |                   reserved                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **magic**: `0x4D47494B` ("MGIK" as big-endian u32)
- **version**: `0x02` = control message, `0x03` = video data

The desktop does **not** send MGIK headers — only the sub-header + payload.

## MGIK Sub-Header (24 bytes, both directions)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        appId (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     datagramId (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      messageId (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      partIndex (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      partCount (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         qos (BE u32)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **appId**: session-specific magic, learned from the Quest's first message, echoed in all replies
- **datagramId**: monotonic per-datagram sequence number
- **messageId**: monotonic per-message sequence number
- **partIndex**: fragment index (`0` for unfragmented messages)
- **partCount**: total fragment count (`1` for unfragmented messages)
- **qos**: always `2` (HIGH)

For unfragmented messages (the common case), the last 12 bytes are always
`0x00000000 0x00000001 0x00000002`.

## Cast Session Handshake

After the TCP connections are established, the MGIK-level handshake follows
this sequence:

```
Quest                              Desktop
  |                                   |
  |--- TRANSPORT string (video) ----->|  identifies video connection
  |--- Sub-header (control) --------->|  desktop learns appId
  |                                   |
  |<-- INIT (×4) --------------------|  cmd 0x258, 16 zero bytes
  |<-- START_CAST --------------------|  cmd 0x07, width/height/UUID/timestamp
  |<-- CONFIRM (×1) -----------------|  cmd 0x12D
  |<-- READY (×1) -------------------|  cmd 0x65
  |                                   |
  |--- LayerConfig ------------------>|  reports layer info (type, resolution)
  |--- VideoMeta + H.264 NAL ------->|  video frames begin flowing
  |                                   |
  |<-- KEEPALIVE ---------------------|  cmd 0x04, periodic
  |<-- POSE --------------------------|  cmd 0xCE, continuous
  |--- ACK --------------------------->|  cumulative acknowledgment
```

### CONFIRM Rules

CONFIRM messages (cmd 0x12D) follow specific rules:

- **1×** after START_CAST (always, initial stream setup)
- **2×** after a RES_CHANGE that changes width or height (encoder reallocation)
- **0×** after a RES_CHANGE that only changes eye selection (same dimensions)

## MUD Message Types

MUD ("Messages Under Delivery") is the application-level message layer carried
inside MGIK framing.

### Quest → Desktop

| Message | Purpose |
|---|---|
| Config | Layer configuration (resolution, serial, APK name) |
| VideoSegment | H.264 NAL units (main payload) |
| AudioSegment | Audio data (48kHz stereo PCM) |
| ACK | Cumulative acknowledgment |
| Ping | Latency measurement |
| AppStateChange | App state transitions |
| MediaAvailable | Media readiness notification |
| StopCasting | Quest-initiated stop |
| DestroyLayer | Layer teardown |

### Desktop → Quest

| Message | Purpose |
|---|---|
| INIT | Session initialization |
| StartCasting | Begin casting (resolution, bitrate, fps) |
| StopCasting | End casting |
| UpdateCastingConfig | Change resolution/bitrate at runtime |
| Pose | 6DoF virtual camera position and orientation |
| RES_CHANGE | Resolution and eye selection |
| CONFIRM | Acknowledge stream setup |
| KEEPALIVE | Session keepalive |
| SetProperty | Key-value configuration |
| SetDeviceEyeFov | FOV parameters |
| Screenshot | Request screenshot |
| AudioState | Enable/disable audio |
| InputForwardingState | Enable/disable input forwarding |
| StartInputForwarding | Begin input forwarding |
| VirtualMouse | Mouse cursor position/clicks |
| ActivateLayer | Select active layer |

## Desktop → Quest Wire Formats

All Desktop → Quest messages are framed as:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                   MGIK Sub-Header (24 bytes)                  |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      command ID (BE u32)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                   command payload (variable)                  |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### INIT (cmd 0x258)

```
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      0x00000258 (INIT)                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                       16 zero bytes                           |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Sent 4 times during handshake.

### START_CAST (cmd 0x07)

```
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    0x00000007 (START_CAST)                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        width (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       height (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000000                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000001                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000000                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000000                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     UUID (MUD string)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   timestamp (MUD string)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### KEEPALIVE (cmd 0x04)

```
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    0x00000004 (KEEPALIVE)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      ack_value (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     UUID (MUD string)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   timestamp (MUD string)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

`ack_value` starts at `0xC8` (200) and increments by `0xC8` each keepalive.

### RES_CHANGE (cmd 0x09)

```
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    0x00000009 (RES_CHANGE)                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        width (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       height (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000000                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     eye selector (BE u32)                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000000                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000000                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Eye selector: `0` = right, `1` = left (default), `2` = stereo (side-by-side).

### POSE (cmd 0xCE)

```
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      0x000000CE (POSE)                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  type (i32) — 0=VIRTUAL_CAMERA                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       posX (BE f32)                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       posY (BE f32)                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       posZ (BE f32)                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        qW (BE f32)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        qX (BE f32)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        qY (BE f32)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        qZ (BE f32)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Coordinates follow OpenXR convention: +X=right, +Y=up, -Z=forward. Position
is relative to the headset's position when casting started (not world space).

The desktop sends pose continuously; the Quest does not report pose back.

### SET_PROPERTY (cmd 0x0A)

```
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   0x0000000A (SET_PROPERTY)                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      key (MUD string)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     value (MUD string)                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### VIRTUAL_MOUSE (cmd 0xC8)

```
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  0x000000C8 (VIRTUAL_MOUSE)                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      layerId (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       action (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         x (BE f32)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         y (BE f32)                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Mouse actions: `1` = move, `3` = button down, `4` = button up.

### Simple Commands

| cmd | Name | Payload |
|-----|------|---------|
| 0x65 (101) | READY | u32(0) |
| 0x08 (8) | STOP | (empty) |
| 0xCD (205) | INPUT_FWD_STATE | u32(state) — 0=normal, 1=camera |
| 0xCF (207) | START_INPUT_FWD | (empty) |
| 0x12D (301) | CONFIRM / ACTIVATE_LAYER | u32(0) or u32(layerId) |
| 0x130 (304) | SCREENSHOT | u32(0) + u32(type) — 1=composite, 2=raw |

## Quest → Desktop Wire Formats

### ACK

Quest ACKs are bare 8-byte messages with **no** MGIK header and **no** sub-header:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       0x00000003 (ACK)                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                 cumulative_ack_counter (BE u32)               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

ACKs are infrequent (~1 per 13 seconds) and cumulative.

### LayerConfig (cmd 0x12C)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  0x0000012C (LAYER_CONFIG)                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       layer id (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        width (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       height (BE u32)                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       posX (BE f32)                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       posY (BE f32)                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       depth (BE f32)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    layer type (BE u32)                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    app name (MUD string)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   layer name (MUD string)                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                 device serial (MUD string)                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                  package name (MUD string)                    |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Layer types: `0` = PANEL_APP, `1` = EYE_BUFFER, `2` = AETHER_APP, `3` = VOLUMETRIC_WINDOW

### VideoMeta + H.264 NAL

Each video frame on the wire is:

```
MGIK header (8B) + sub-header (24B) + VideoMeta (16B) + H.264 NAL data
```

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    0x00000064 (VIDEO_META)                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      chunk_type (BE u32)                      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      frame_index (BE u32)                     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        reserved                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                H.264 NAL data (Annex B format)                |
|                  0x00000001 start codes                       |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Chunk types: `1` = SPS/PPS, `2` = IDR (keyframe), `3` = P-frame

## MUD String Encoding

Strings in MUD messages use a length-prefixed encoding with 4-byte alignment:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                    byte length (BE u32)                       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                     UTF-8 string data                         |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|              padding (0-3 zero bytes to align)                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

## Video Stream

The Quest sends H.264 video with these characteristics:

- **Profile**: High, Level 5.0
- **Pixel format**: YUV420P, BT.709 color space
- **NAL format**: Annex B (0x00000001 start codes)
- **Frame types**: SPS/PPS, IDR (keyframes), P-frames
- **Default resolution**: 2064×1162 (16:9 mono)
- **Default bitrate**: 40 Mbps

### Eye View

Eye selection is controlled via RES_CHANGE (cmd 0x09):

| Eye | Value | Resolution | Layout |
|---|---|---|---|
| Right | 0 | 2064×2208 or 2064×1162 | Single eye |
| Left (default) | 1 | 2064×2208 or 2064×1162 | Single eye |
| Stereo | 2 | 4128×2208 | Both eyes side-by-side |

START_CAST does not include the eye field — initial eye defaults to left.

### Resolution Presets

| Key | Display | Aspect |
|---|---|---|
| `1024p36fps` | 1024p @ 36fps | 1:1 (default) |
| `1024p60fps` | 1024p @ 60fps | 1:1 |
| `1080p36fps` | 1080p @ 36fps | 16:9 |
| `1080p60fps` | 1080p @ 60fps | 16:9 |
| `1440p36fps` | 1440p @ 36fps | 16:9 |
| `1440p60fps` | 1440p @ 60fps | 16:9 |
| `2160p36fps` | 2160p @ 36fps | 16:9 |
| `2160p60fps` | 2160p @ 60fps | 16:9 |

### Bitrate

| Value | Quality |
|---|---|
| 5 Mbps | Very low (default) |
| 8 Mbps | Low |
| 25 Mbps | High |
| 40 Mbps | Very high |

## ADB Setup

### Casting Lifecycle

```bash
# Set media capture mode (required before casting)
adb shell setprop debug.oculus.command_line_media_capture Casting

# Disable proximity sensor (prevents sleep when headset removed)
adb shell am broadcast -a com.oculus.vrpowermanager.prox_close --ei duration 600000

# Disable guardian boundaries
adb shell setprop debug.oculus.guardian_pause 1

# Stop casting
adb shell am broadcast -a com.oculus.magicislandcastingservice.STOP_CASTING

# Re-enable proximity sensor
adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable
```

### Casting Service Intents

```
com.oculus.magicislandcastingservice.START_CASTING
com.oculus.magicislandcastingservice.STOP_CASTING
com.oculus.magicislandcastingservice.CONNECT
com.oculus.magicislandcastingservice.START_RECORDING
com.oculus.magicislandcastingservice.STOP_RECORDING
com.oculus.magicislandcastingservice.UPDATE_CASTING_CONFIG
com.oculus.magicislandcastingservice.SET_DEVICE_EYE_FOV
com.oculus.magicislandcastingservice.ENABLE_PANEL_STREAMING
com.oculus.magicislandcastingservice.DISABLE_PANEL_STREAMING
```

### Feature Flags

Feature flags control optional capabilities:

- `wireless_casting_2` — WiFi casting
- `input_forwarding_2` — Keyboard/mouse forwarding
- `gaze_click` — Gaze-based click input
- `text_forwarding` — Text input forwarding
- `mic_audio` — Microphone audio
- `image_stabilization` — Image stabilization
- `obs_support` — OBS integration
- `panel_streaming` — 2D panel streaming

### Configuration Properties

Runtime configuration via SET_PROPERTY (cmd 0x0A). All keys are in the
`debug.oculus.magic.*` namespace and can also be set via
`adb shell setprop debug.oculus.magic.<key> <value>`.

| Property | Default | Unit |
|----------|---------|------|
| `serverPort` | 4445 | TCP port |
| `captureEncoderBitrate` | 40,000,000 | bits/sec |
| `maxEncoderFps` | 60 | fps |
| `minEncoderFps` | 30 | fps |
| `scalingFactor` | 1.0 | multiplier |
| `remoteInputFrameValidDuration` | 5.0 | seconds |
| `targetAudioLatency` | 0.05 | seconds |
| `audioCaptureBitrate` | 160,000 | bits/sec |
| `congestionControlWindow` | 1.0 | seconds |
| `congestionControlMultiplicativeDecrease` | 0.85 | multiplier |
| `congestionControlAdditiveIncrease` | 250,000 | bits/sec |
| `transportConnectTimeout` | 5,000 | ms |
| `transportConnectRetryInterval` | 5,000 | ms |

