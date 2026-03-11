/**
 * JPEG COM marker insertion.
 * Inserts a COM (0xFFFE) marker after the SOI marker without re-encoding.
 */

import { readFileSync, writeFileSync } from "fs";

/**
 * Insert a COM comment marker into a JPEG buffer.
 * Splices after the SOI (FF D8) marker — no re-encoding, no quality loss.
 */
export function insertJpegComment(jpeg: Buffer, comment: string): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("Not a valid JPEG (missing SOI marker)");
  }
  const payload = Buffer.from(comment, "utf-8");
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xfffe, 0);
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, payload, jpeg.subarray(2)]);
}

/**
 * Add a COM comment to a JPEG file in-place.
 */
export function addJpegFileComment(filePath: string, comment: string): void {
  const jpeg = readFileSync(filePath);
  const result = insertJpegComment(jpeg, comment);
  writeFileSync(filePath, result);
}
