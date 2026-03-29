import { describe, expect, it } from "vitest";
import {
  detectSubMagic,
  isMgikMagic,
  packMgikSub,
  parseMgikSub,
} from "../src/mgik.js";
import { MGIK_SUB_HEADER_SIZE } from "../src/constants.js";

describe("MGIK", () => {
  describe("packMgikSub / parseMgikSub round-trip", () => {
    it("round-trips with typical values", () => {
      const subMagic = 0xdeadbeef;
      const msgSeq = 5;
      const packed = packMgikSub(subMagic, msgSeq);
      expect(packed.length).toBe(MGIK_SUB_HEADER_SIZE);

      const parsed = parseMgikSub(packed);
      expect(parsed).not.toBeNull();
      expect(parsed!.subMagic).toBe(subMagic);
      expect(parsed!.msgSeq).toBe(msgSeq);
      expect(parsed!.ackSeq).toBe(msgSeq); // ack_seq defaults to msg_seq
    });

    it("includes fixed tail (0, 1, 2)", () => {
      const packed = packMgikSub(0x12345678, 0);
      expect(packed.readUInt32BE(12)).toBe(0);
      expect(packed.readUInt32BE(16)).toBe(1);
      expect(packed.readUInt32BE(20)).toBe(2);
    });
  });

  describe("parseMgikSub", () => {
    it("returns null for too-short buffer", () => {
      expect(parseMgikSub(Buffer.alloc(20))).toBeNull();
    });
  });

  describe("detectSubMagic", () => {
    it("detects sub_magic from a valid Quest initial message", () => {
      const buf = Buffer.alloc(MGIK_SUB_HEADER_SIZE);
      buf.writeUInt32BE(0xaabbccdd, 0); // sub_magic
      buf.writeUInt32BE(0, 4); // msg_seq
      buf.writeUInt32BE(0, 8); // ack_seq
      buf.writeUInt32BE(0, 12);
      buf.writeUInt32BE(1, 16);
      buf.writeUInt32BE(2, 20);
      expect(detectSubMagic(buf)).toBe(0xaabbccdd);
    });

    it("returns null if tail signature does not match", () => {
      const buf = Buffer.alloc(MGIK_SUB_HEADER_SIZE);
      buf.writeUInt32BE(0xaabbccdd, 0);
      buf.writeUInt32BE(0, 12);
      buf.writeUInt32BE(1, 16);
      buf.writeUInt32BE(3, 20); // wrong: should be 2
      expect(detectSubMagic(buf)).toBeNull();
    });

    it("returns null for wrong-sized payload", () => {
      expect(detectSubMagic(Buffer.alloc(16))).toBeNull();
      expect(detectSubMagic(Buffer.alloc(32))).toBeNull();
    });
  });

  describe("isMgikMagic", () => {
    it("detects MGIK magic bytes", () => {
      const buf = Buffer.from("MGIK", "ascii");
      expect(isMgikMagic(buf)).toBe(true);
    });

    it("rejects non-MGIK bytes", () => {
      expect(isMgikMagic(Buffer.from("XRSP"))).toBe(false);
    });

    it("returns false for short buffer", () => {
      expect(isMgikMagic(Buffer.from("MG"))).toBe(false);
    });
  });
});
