/**
 * MUD (Messages Under Delivery) message builders and parsers.
 *
 * All MUD payloads are big-endian and prefixed with a MGIK sub-header.
 * Each builder returns a complete XRSP payload: sub_header + command_id + body.
 */

import {
  CMD_ACTIVATE_LAYER,
  CMD_CONFIG,
  CMD_DISCONNECT,
  CMD_DISPLAY_CONFIG,
  CMD_INIT,
  CMD_INPUT_FORWARDING_STATE,
  CMD_KEEPALIVE,
  CMD_POSE,
  CMD_SET_PROPERTY,
  CMD_START_INPUT_FORWARDING,
  CMD_VIRTUAL_MOUSE,
  LAYER_TYPE_NAMES,
} from "./constants.js";
import { packMgikSub } from "./mgik.js";
import type { LayerInfo, PoseState } from "./types.js";

/**
 * Pack a MUD-style length-prefixed string with 4-byte alignment padding.
 */
export function packMudString(s: string): Buffer {
  const raw = Buffer.from(s, "utf-8");
  const padLen = (4 - (raw.length % 4)) % 4;
  const buf = Buffer.alloc(4 + raw.length + padLen);
  buf.writeUInt32BE(raw.length, 0);
  raw.copy(buf, 4);
  return buf;
}

/**
 * Parse a MUD-style length-prefixed string from a buffer at an offset.
 * Returns the parsed string and the next offset (after alignment padding).
 */
export function parseMudString(
  buf: Buffer,
  offset: number,
): { value: string; nextOffset: number } {
  if (offset + 4 > buf.length) {
    return { value: "", nextOffset: buf.length };
  }
  const slen = buf.readUInt32BE(offset);
  offset += 4;
  if (offset + slen > buf.length) {
    return { value: "", nextOffset: buf.length };
  }
  const value = buf.subarray(offset, offset + slen).toString("utf-8");
  offset += slen;
  offset += (4 - (slen % 4)) % 4; // alignment padding
  return { value, nextOffset: offset };
}

/** Build Init command (0x258) payload. */
export function buildInit(subMagic: number, seq: number): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const body = Buffer.alloc(4 + 16); // cmd + 16 zero bytes
  body.writeUInt32BE(CMD_INIT, 0);
  return Buffer.concat([sub, body]);
}

/** Build Config command (0x07) payload. */
export function buildConfig(
  subMagic: number,
  seq: number,
  width: number,
  height: number,
  uuid: string,
  timestamp: string,
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  // cmd(4) + width(4) + height(4) + 0(4) + 1(4) + 0(4) + 0(4) = 28 bytes
  const body = Buffer.alloc(28);
  body.writeUInt32BE(CMD_CONFIG, 0);
  body.writeUInt32BE(width, 4);
  body.writeUInt32BE(height, 8);
  body.writeUInt32BE(0, 12);
  body.writeUInt32BE(1, 16);
  body.writeUInt32BE(0, 20);
  body.writeUInt32BE(0, 24);
  const uuidStr = packMudString(uuid);
  const tsStr = packMudString(timestamp);
  return Buffer.concat([sub, body, uuidStr, tsStr]);
}

/** Build Keepalive command (0x04) payload. */
export function buildKeepalive(
  subMagic: number,
  msgSeq: number,
  ackVal: number,
  uuid: string,
  timestamp: string,
): Buffer {
  const sub = packMgikSub(subMagic, msgSeq);
  const body = Buffer.alloc(8);
  body.writeUInt32BE(CMD_KEEPALIVE, 0);
  body.writeUInt32BE(ackVal, 4);
  const uuidStr = packMudString(uuid);
  const tsStr = packMudString(timestamp);
  return Buffer.concat([sub, body, uuidStr, tsStr]);
}

/** Build short ack payload (sub_header + cmd + 0). */
export function buildShortAck(
  subMagic: number,
  msgSeq: number,
  cmd: number,
): Buffer {
  const sub = packMgikSub(subMagic, msgSeq);
  const body = Buffer.alloc(8);
  body.writeUInt32BE(cmd, 0);
  body.writeUInt32BE(0, 4);
  return Buffer.concat([sub, body]);
}

/** Build Pose command (0xCE) payload. */
export function buildPose(subMagic: number, seq: number, pose: PoseState): Buffer {
  const sub = packMgikSub(subMagic, seq);
  // cmd(4) + 8 floats (32 bytes) = 36 bytes
  const body = Buffer.alloc(36);
  body.writeUInt32BE(CMD_POSE, 0);
  // Wire order: type(0), posX, posY, posZ, qw, qx, qy, qz
  body.writeFloatBE(0.0, 4);
  body.writeFloatBE(pose.x, 8);
  body.writeFloatBE(pose.y, 12);
  body.writeFloatBE(pose.z, 16);
  body.writeFloatBE(pose.qw, 20);
  body.writeFloatBE(pose.qx, 24);
  body.writeFloatBE(pose.qy, 28);
  body.writeFloatBE(pose.qz, 32);
  return Buffer.concat([sub, body]);
}

/** Eye selector values for DisplayConfig (cmd 0x09). */
export const EYE_RIGHT = 0;
export const EYE_LEFT = 1;
export const EYE_STEREO = 2;

/** Build DisplayConfig / RES_CHANGE command (0x09) payload. */
export function buildDisplayConfig(
  subMagic: number,
  seq: number,
  width: number,
  height: number,
  eye: number = EYE_LEFT,
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  // Wire: u32(cmd) + u32(width) + u32(height) + u32(0) + u32(eye) + u32(0) + u32(0)
  const body = Buffer.alloc(4 * 7);
  body.writeUInt32BE(CMD_DISPLAY_CONFIG, 0);
  body.writeUInt32BE(width, 4);
  body.writeUInt32BE(height, 8);
  body.writeUInt32BE(eye, 16);
  return Buffer.concat([sub, body]);
}

/** Build Disconnect command (0x08) payload. */
export function buildDisconnect(subMagic: number, seq: number): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const body = Buffer.alloc(4);
  body.writeUInt32BE(CMD_DISCONNECT, 0);
  return Buffer.concat([sub, body]);
}

/** Build SetProperty MUD type 10 payload. */
export function buildSetProperty(
  subMagic: number,
  seq: number,
  name: string,
  value: string,
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const cmd = Buffer.alloc(4);
  cmd.writeUInt32BE(CMD_SET_PROPERTY, 0);
  return Buffer.concat([sub, cmd, packMudString(name), packMudString(value)]);
}

/** Build VirtualMouse MUD type 200 payload. */
export function buildVirtualMouse(
  subMagic: number,
  seq: number,
  layerId: number,
  action: number,
  x: number,
  y: number,
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const body = Buffer.alloc(4 + 4 + 4 + 4 + 4); // cmd + layerId + action + x(f32) + y(f32)
  body.writeUInt32BE(CMD_VIRTUAL_MOUSE, 0);
  body.writeUInt32BE(layerId, 4);
  body.writeUInt32BE(action, 8);
  body.writeFloatBE(x, 12);
  body.writeFloatBE(y, 16);
  return Buffer.concat([sub, body]);
}

/** Build InputForwardingStateChange MUD type 205 payload. */
export function buildInputForwardingState(
  subMagic: number,
  seq: number,
  state: number,
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const body = Buffer.alloc(8);
  body.writeUInt32BE(CMD_INPUT_FORWARDING_STATE, 0);
  body.writeUInt32BE(state, 4);
  return Buffer.concat([sub, body]);
}

/** Build StartInputForwarding MUD type 207 payload. */
export function buildStartInputForwarding(
  subMagic: number,
  seq: number,
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const cmd = Buffer.alloc(4);
  cmd.writeUInt32BE(CMD_START_INPUT_FORWARDING, 0);
  return Buffer.concat([sub, cmd]);
}

/** Build ActivateLayer MUD type 301 payload. */
export function buildActivateLayer(
  subMagic: number,
  seq: number,
  layerId: number,
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const body = Buffer.alloc(8);
  body.writeUInt32BE(CMD_ACTIVATE_LAYER, 0);
  body.writeUInt32BE(layerId, 4);
  return Buffer.concat([sub, body]);
}

/** Build arbitrary MUD message: sub_header + cmd(4) + payload. */
export function buildMud(
  subMagic: number,
  seq: number,
  typeId: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const sub = packMgikSub(subMagic, seq);
  const cmd = Buffer.alloc(4);
  cmd.writeUInt32BE(typeId, 0);
  return Buffer.concat([sub, cmd, payload]);
}

/**
 * Parse a LayerConfiguration (type 0x12C / 300) payload.
 * Returns null if the payload is too short.
 */
export function parseLayerConfiguration(payload: Buffer): LayerInfo | null {
  // Minimum: cmd(4) + id(4) + w(4) + h(4) + posX(4) + posY(4) + depth(4) + type(4) = 32
  if (payload.length < 32) {
    return null;
  }

  const id = payload.readUInt32BE(4);
  const width = payload.readUInt32BE(8);
  const height = payload.readUInt32BE(12);
  const posX = payload.readFloatBE(16);
  const posY = payload.readFloatBE(20);
  const depth = payload.readFloatBE(24);
  const type = payload.readUInt32BE(28);
  const typeName = LAYER_TYPE_NAMES[type] ?? `UNKNOWN(${type})`;

  // Parse 4 strings: appName, layerName, deviceSerial, packageName
  const strings: string[] = [];
  let offset = 32;
  for (let i = 0; i < 4; i++) {
    const result = parseMudString(payload, offset);
    strings.push(result.value);
    offset = result.nextOffset;
  }

  return {
    id,
    width,
    height,
    posX,
    posY,
    depth,
    type,
    typeName,
    app: strings[0] ?? "",
    layer: strings[1] ?? "",
    serial: strings[2] ?? "",
    pkg: strings[3] ?? "",
  };
}
