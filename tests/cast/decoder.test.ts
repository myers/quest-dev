import { describe, expect, it } from "vitest";
import { extractJpegFrames } from "../../src/cast/decoder.js";

describe("extractJpegFrames", () => {
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);

  function makeJpeg(bodySize: number): Buffer {
    const body = Buffer.alloc(bodySize, 0x42);
    return Buffer.concat([SOI, body, EOI]);
  }

  it("returns no frames from empty buffer", () => {
    const result = extractJpegFrames(Buffer.alloc(0));
    expect(result.frames).toHaveLength(0);
    expect(result.remainder.length).toBe(0);
  });

  it("returns no frames from buffer without markers", () => {
    const result = extractJpegFrames(Buffer.alloc(100, 0x42));
    expect(result.frames).toHaveLength(0);
    expect(result.remainder.length).toBe(0);
  });

  it("extracts a single complete JPEG frame", () => {
    const jpeg = makeJpeg(10);
    const result = extractJpegFrames(jpeg);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toEqual(jpeg);
    expect(result.remainder.length).toBe(0);
  });

  it("extracts multiple JPEG frames", () => {
    const j1 = makeJpeg(5);
    const j2 = makeJpeg(8);
    const buf = Buffer.concat([j1, j2]);
    const result = extractJpegFrames(buf);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toEqual(j1);
    expect(result.frames[1]).toEqual(j2);
    expect(result.remainder.length).toBe(0);
  });

  it("handles partial frame (SOI without EOI)", () => {
    const partial = Buffer.concat([SOI, Buffer.alloc(10, 0x42)]);
    const result = extractJpegFrames(partial);
    expect(result.frames).toHaveLength(0);
    expect(result.remainder).toEqual(partial);
  });

  it("extracts complete frame and keeps partial remainder", () => {
    const complete = makeJpeg(5);
    const partial = Buffer.concat([SOI, Buffer.alloc(3, 0x42)]);
    const buf = Buffer.concat([complete, partial]);
    const result = extractJpegFrames(buf);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toEqual(complete);
    expect(result.remainder).toEqual(partial);
  });

  it("skips garbage before SOI", () => {
    const garbage = Buffer.alloc(20, 0xab);
    const jpeg = makeJpeg(5);
    const buf = Buffer.concat([garbage, jpeg]);
    const result = extractJpegFrames(buf);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toEqual(jpeg);
  });

  it("handles zero-length body JPEG", () => {
    const jpeg = Buffer.concat([SOI, EOI]);
    const result = extractJpegFrames(jpeg);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toEqual(jpeg);
  });

  it("handles buffer that is just SOI", () => {
    const result = extractJpegFrames(SOI);
    expect(result.frames).toHaveLength(0);
    expect(result.remainder).toEqual(SOI);
  });
});
