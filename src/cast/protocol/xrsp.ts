/**
 * XRSP frame packing and parsing.
 *
 * XRSP header is 8 bytes, little-endian:
 *   flags(1) + topic(1) + word_count(2 LE) + seq(2 LE) + pad(2 LE)
 *
 * Payload is padded to 4-byte alignment.
 * Total packet size = word_count × 4 bytes (includes the 8-byte header as 2 words).
 * Payload size = (word_count - 1) × 4 bytes... wait, looking at Python:
 *   word_count = len(padded_payload) / 4 + 1
 * So header takes 2 words (8 bytes) but word_count only accounts for 1 word of header?
 * Actually the pack_xrsp packs the 8-byte header separately, then appends padded payload.
 * word_count = padded_payload_len/4 + 1, so payload_size = (word_count - 1) * 4.
 * The header itself is NOT counted in word_count properly — it's prepended separately.
 */

import {
  XRSP_FLAGS_STANDARD,
  XRSP_HEADER_SIZE,
  XRSP_TOPIC_CAST,
} from "./constants.js";
import type { XrspHeader } from "./types.js";

/**
 * Pack an XRSP frame: 8-byte LE header + padded payload.
 */
export function packXrsp(
  seq: number,
  payload: Buffer,
  flags: number = XRSP_FLAGS_STANDARD,
  topic: number = XRSP_TOPIC_CAST,
): Buffer {
  const padLen = (4 - (payload.length % 4)) % 4;
  const paddedLen = payload.length + padLen;
  const wordCount = paddedLen / 4 + 1;

  const header = Buffer.alloc(XRSP_HEADER_SIZE);
  header.writeUInt8(flags, 0);
  header.writeUInt8(topic, 1);
  header.writeUInt16LE(wordCount, 2);
  header.writeUInt16LE(seq, 4);
  header.writeUInt16LE(0, 6); // padding field

  if (padLen === 0) {
    return Buffer.concat([header, payload]);
  }
  return Buffer.concat([header, payload, Buffer.alloc(padLen)]);
}

/**
 * Parse an XRSP header from the first 8 bytes of a buffer.
 */
export function parseXrspHeader(data: Buffer): XrspHeader {
  if (data.length < XRSP_HEADER_SIZE) {
    throw new Error(
      `XRSP header requires ${XRSP_HEADER_SIZE} bytes, got ${data.length}`,
    );
  }
  return {
    flags: data.readUInt8(0),
    topic: data.readUInt8(1) & 0x3f,
    wordCount: data.readUInt16LE(2),
    seq: data.readUInt16LE(4),
    padding: data.readUInt16LE(6),
  };
}

/**
 * Compute payload size from an XRSP header.
 */
export function xrspPayloadSize(header: XrspHeader): number {
  return Math.max(0, (header.wordCount - 1) * 4);
}
