import { describe, expect, it } from "vitest";
import {
  packXrsp,
  parseXrspHeader,
  xrspPayloadSize,
} from "../src/xrsp.js";
import {
  XRSP_FLAGS_STANDARD,
  XRSP_HEADER_SIZE,
  XRSP_TOPIC_CAST,
} from "../src/constants.js";

describe("XRSP", () => {
  describe("packXrsp / parseXrspHeader round-trip", () => {
    it("round-trips with empty payload", () => {
      const packed = packXrsp(0, Buffer.alloc(0));
      expect(packed.length).toBe(XRSP_HEADER_SIZE); // header only, word_count=1
      const header = parseXrspHeader(packed);
      expect(header.flags).toBe(XRSP_FLAGS_STANDARD);
      expect(header.topic).toBe(XRSP_TOPIC_CAST);
      expect(header.wordCount).toBe(1);
      expect(header.seq).toBe(0);
      expect(xrspPayloadSize(header)).toBe(0);
    });

    it("round-trips with 4-byte aligned payload", () => {
      const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const packed = packXrsp(42, payload);
      expect(packed.length).toBe(XRSP_HEADER_SIZE + 4);
      const header = parseXrspHeader(packed);
      expect(header.wordCount).toBe(2); // 4 bytes / 4 + 1
      expect(header.seq).toBe(42);
      expect(xrspPayloadSize(header)).toBe(4);
      // Verify payload preserved
      expect(packed.subarray(XRSP_HEADER_SIZE)).toEqual(payload);
    });

    it("pads non-aligned payload to 4 bytes", () => {
      const payload = Buffer.from([0xaa, 0xbb]); // 2 bytes → padded to 4
      const packed = packXrsp(1, payload);
      expect(packed.length).toBe(XRSP_HEADER_SIZE + 4);
      const header = parseXrspHeader(packed);
      expect(header.wordCount).toBe(2);
      // First 2 bytes are payload, next 2 are zero padding
      expect(packed[XRSP_HEADER_SIZE]).toBe(0xaa);
      expect(packed[XRSP_HEADER_SIZE + 1]).toBe(0xbb);
      expect(packed[XRSP_HEADER_SIZE + 2]).toBe(0);
      expect(packed[XRSP_HEADER_SIZE + 3]).toBe(0);
    });

    it("pads 5-byte payload to 8 bytes", () => {
      const payload = Buffer.alloc(5, 0xff);
      const packed = packXrsp(0, payload);
      expect(packed.length).toBe(XRSP_HEADER_SIZE + 8);
      const header = parseXrspHeader(packed);
      expect(header.wordCount).toBe(3); // 8/4 + 1
      expect(xrspPayloadSize(header)).toBe(8);
    });

    it("preserves custom flags", () => {
      const packed = packXrsp(0, Buffer.alloc(0), 0x18);
      const header = parseXrspHeader(packed);
      expect(header.flags).toBe(0x18);
    });

    it("masks topic to 6 bits", () => {
      // Topic byte on wire might have high bits, parseXrspHeader masks to 0x3F
      const buf = Buffer.alloc(XRSP_HEADER_SIZE);
      buf.writeUInt8(0x10, 0); // flags
      buf.writeUInt8(0xc2, 1); // topic = 0xC2, masked = 0x02
      buf.writeUInt16LE(1, 2);
      const header = parseXrspHeader(buf);
      expect(header.topic).toBe(2);
    });
  });

  describe("parseXrspHeader", () => {
    it("throws on too-short buffer", () => {
      expect(() => parseXrspHeader(Buffer.alloc(4))).toThrow();
    });
  });

  describe("sequence number wrapping", () => {
    it("handles high sequence numbers", () => {
      const packed = packXrsp(65535, Buffer.alloc(0));
      const header = parseXrspHeader(packed);
      expect(header.seq).toBe(65535);
    });
  });
});
