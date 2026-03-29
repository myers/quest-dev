/**
 * MGIK sub-header packing and parsing.
 *
 * MGIK sub-header is 24 bytes, big-endian:
 *   sub_magic(4 BE) + msg_seq(4 BE) + ack_seq(4 BE) + 0(4 BE) + 1(4 BE) + 2(4 BE)
 *
 * The sub_magic is learned from the Quest's first message.
 * The tail (0, 1, 2) is a fixed signature.
 */

import { MGIK_MAGIC, MGIK_SUB_HEADER_SIZE } from "./constants.js";
import type { MgikSubHeader } from "./types.js";

/**
 * Pack a MGIK sub-header (24 bytes, big-endian).
 * ack_seq defaults to msg_seq (matching the Python implementation).
 */
export function packMgikSub(subMagic: number, msgSeq: number): Buffer {
  const buf = Buffer.alloc(MGIK_SUB_HEADER_SIZE);
  buf.writeUInt32BE(subMagic, 0);
  buf.writeUInt32BE(msgSeq, 4);
  buf.writeUInt32BE(msgSeq, 8); // ack_seq = msg_seq
  buf.writeUInt32BE(0, 12);
  buf.writeUInt32BE(1, 16);
  buf.writeUInt32BE(2, 20);
  return buf;
}

/**
 * Parse a MGIK sub-header from a buffer.
 * Returns null if the buffer is too small.
 */
export function parseMgikSub(data: Buffer): MgikSubHeader | null {
  if (data.length < MGIK_SUB_HEADER_SIZE) {
    return null;
  }
  return {
    subMagic: data.readUInt32BE(0),
    msgSeq: data.readUInt32BE(4),
    ackSeq: data.readUInt32BE(8),
  };
}

/**
 * Detect the sub_magic from a Quest initial message.
 *
 * The Quest sends a 24-byte payload where the last 12 bytes are (0, 1, 2).
 * The first 4 bytes are the sub_magic value.
 */
export function detectSubMagic(payload: Buffer): number | null {
  if (payload.length !== MGIK_SUB_HEADER_SIZE) {
    return null;
  }
  const tail0 = payload.readUInt32BE(12);
  const tail1 = payload.readUInt32BE(16);
  const tail2 = payload.readUInt32BE(20);
  if (tail0 === 0 && tail1 === 1 && tail2 === 2) {
    return payload.readUInt32BE(0);
  }
  return null;
}

/**
 * Check if the first 4 bytes of payload match "MGIK" magic.
 */
export function isMgikMagic(payload: Buffer): boolean {
  if (payload.length < 4) return false;
  return payload.readUInt32BE(0) === MGIK_MAGIC;
}
