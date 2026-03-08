import { describe, expect, it } from "vitest";
import {
  buildActivateLayer,
  buildConfig,
  buildDisconnect,
  buildDisplayConfig,
  buildInit,
  buildInputForwardingState,
  buildKeepalive,
  buildMud,
  buildPose,
  buildSetProperty,
  buildShortAck,
  buildStartInputForwarding,
  buildVirtualMouse,
  packMudString,
  parseLayerConfiguration,
  parseMudString,
} from "../../../src/cast/protocol/mud.js";
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
  CMD_SHORT_ACK_65,
  CMD_START_INPUT_FORWARDING,
  CMD_VIRTUAL_MOUSE,
  MGIK_SUB_HEADER_SIZE,
} from "../../../src/cast/protocol/constants.js";
import type { PoseState } from "../../../src/cast/protocol/types.js";

const SUB_MAGIC = 0xdeadbeef;

/** Helper: read command ID from payload after sub-header. */
function readCmd(payload: Buffer): number {
  return payload.readUInt32BE(MGIK_SUB_HEADER_SIZE);
}

/** Helper: verify sub-header in payload. */
function verifySubHeader(payload: Buffer, subMagic: number, seq: number) {
  expect(payload.readUInt32BE(0)).toBe(subMagic);
  expect(payload.readUInt32BE(4)).toBe(seq);
}

describe("MUD strings", () => {
  describe("packMudString / parseMudString round-trip", () => {
    it("round-trips a simple string", () => {
      const packed = packMudString("hello");
      const { value, nextOffset } = parseMudString(packed, 0);
      expect(value).toBe("hello");
      // "hello" = 5 bytes, padded to 8, plus 4 byte length prefix = 12
      expect(nextOffset).toBe(12);
    });

    it("round-trips an aligned string (4 bytes)", () => {
      const packed = packMudString("test");
      const { value, nextOffset } = parseMudString(packed, 0);
      expect(value).toBe("test");
      expect(nextOffset).toBe(8); // 4 len + 4 data, no padding needed
    });

    it("round-trips empty string", () => {
      const packed = packMudString("");
      const { value, nextOffset } = parseMudString(packed, 0);
      expect(value).toBe("");
      expect(nextOffset).toBe(4); // just the length prefix
    });

    it("handles UTF-8", () => {
      const packed = packMudString("caf\u00e9");
      const { value } = parseMudString(packed, 0);
      expect(value).toBe("caf\u00e9");
    });
  });

  describe("parseMudString edge cases", () => {
    it("returns empty for offset at buffer end", () => {
      const { value, nextOffset } = parseMudString(Buffer.alloc(4), 4);
      expect(value).toBe("");
      expect(nextOffset).toBe(4);
    });
  });
});

describe("MUD builders", () => {
  describe("buildInit", () => {
    it("builds correct init payload", () => {
      const payload = buildInit(SUB_MAGIC, 0);
      verifySubHeader(payload, SUB_MAGIC, 0);
      expect(readCmd(payload)).toBe(CMD_INIT);
      // 16 zero bytes after command
      const trailing = payload.subarray(MGIK_SUB_HEADER_SIZE + 4);
      expect(trailing.length).toBe(16);
      expect(trailing.every((b) => b === 0)).toBe(true);
    });
  });

  describe("buildConfig", () => {
    it("encodes width, height, uuid, and timestamp", () => {
      const payload = buildConfig(SUB_MAGIC, 1, 2064, 1162, "test-uuid", "12345");
      verifySubHeader(payload, SUB_MAGIC, 1);
      expect(readCmd(payload)).toBe(CMD_CONFIG);
      // Width at sub_header(24) + cmd(4) + offset 4
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 4)).toBe(2064);
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 8)).toBe(1162);
    });
  });

  describe("buildKeepalive", () => {
    it("encodes ack value and strings", () => {
      const payload = buildKeepalive(SUB_MAGIC, 5, 0xc8, "uuid1", "ts1");
      verifySubHeader(payload, SUB_MAGIC, 5);
      expect(readCmd(payload)).toBe(CMD_KEEPALIVE);
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 4)).toBe(0xc8);
    });
  });

  describe("buildShortAck", () => {
    it("encodes command and zero", () => {
      const payload = buildShortAck(SUB_MAGIC, 3, CMD_SHORT_ACK_65);
      verifySubHeader(payload, SUB_MAGIC, 3);
      expect(readCmd(payload)).toBe(CMD_SHORT_ACK_65);
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 4)).toBe(0);
    });
  });

  describe("buildPose", () => {
    it("encodes pose with correct wire order", () => {
      const pose: PoseState = {
        x: 1.0, y: 2.0, z: 3.0,
        qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0,
        yaw: 0, pitch: 0,
      };
      const payload = buildPose(SUB_MAGIC, 0, pose);
      verifySubHeader(payload, SUB_MAGIC, 0);
      expect(readCmd(payload)).toBe(CMD_POSE);
      const off = MGIK_SUB_HEADER_SIZE + 4;
      // Wire order: unused, y, z, x, qw, qx, qy, qz, unused
      expect(payload.readFloatBE(off)).toBeCloseTo(0.0); // unused
      expect(payload.readFloatBE(off + 4)).toBeCloseTo(2.0); // y
      expect(payload.readFloatBE(off + 8)).toBeCloseTo(3.0); // z
      expect(payload.readFloatBE(off + 12)).toBeCloseTo(1.0); // x
      expect(payload.readFloatBE(off + 16)).toBeCloseTo(1.0); // qw
      expect(payload.readFloatBE(off + 20)).toBeCloseTo(0.0); // qx
      expect(payload.readFloatBE(off + 24)).toBeCloseTo(0.0); // qy
      expect(payload.readFloatBE(off + 28)).toBeCloseTo(0.0); // qz
      expect(payload.readFloatBE(off + 32)).toBeCloseTo(0.0); // unused
    });
  });

  describe("buildDisplayConfig", () => {
    it("encodes width and height", () => {
      const payload = buildDisplayConfig(SUB_MAGIC, 0, 1920, 1080);
      verifySubHeader(payload, SUB_MAGIC, 0);
      expect(readCmd(payload)).toBe(CMD_DISPLAY_CONFIG);
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 4)).toBe(1920);
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 8)).toBe(1080);
    });
  });

  describe("buildDisconnect", () => {
    it("has only command ID", () => {
      const payload = buildDisconnect(SUB_MAGIC, 0);
      verifySubHeader(payload, SUB_MAGIC, 0);
      expect(readCmd(payload)).toBe(CMD_DISCONNECT);
      expect(payload.length).toBe(MGIK_SUB_HEADER_SIZE + 4);
    });
  });

  describe("buildSetProperty", () => {
    it("encodes name and value strings", () => {
      const payload = buildSetProperty(SUB_MAGIC, 0, "key", "val");
      verifySubHeader(payload, SUB_MAGIC, 0);
      expect(readCmd(payload)).toBe(CMD_SET_PROPERTY);
      // Parse name string after cmd
      const nameResult = parseMudString(payload, MGIK_SUB_HEADER_SIZE + 4);
      expect(nameResult.value).toBe("key");
      const valueResult = parseMudString(payload, nameResult.nextOffset);
      expect(valueResult.value).toBe("val");
    });
  });

  describe("buildVirtualMouse", () => {
    it("encodes layer, action, and coordinates", () => {
      const payload = buildVirtualMouse(SUB_MAGIC, 0, 5, 3, 0.5, 0.5);
      verifySubHeader(payload, SUB_MAGIC, 0);
      expect(readCmd(payload)).toBe(CMD_VIRTUAL_MOUSE);
      const off = MGIK_SUB_HEADER_SIZE + 4;
      expect(payload.readUInt32BE(off)).toBe(5); // layerId
      expect(payload.readUInt32BE(off + 4)).toBe(3); // action
      expect(payload.readFloatBE(off + 8)).toBeCloseTo(0.5); // x
      expect(payload.readFloatBE(off + 12)).toBeCloseTo(0.5); // y
    });
  });

  describe("buildInputForwardingState", () => {
    it("encodes state value", () => {
      const payload = buildInputForwardingState(SUB_MAGIC, 0, 1);
      expect(readCmd(payload)).toBe(CMD_INPUT_FORWARDING_STATE);
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 4)).toBe(1);
    });
  });

  describe("buildStartInputForwarding", () => {
    it("has only command ID", () => {
      const payload = buildStartInputForwarding(SUB_MAGIC, 0);
      expect(readCmd(payload)).toBe(CMD_START_INPUT_FORWARDING);
      expect(payload.length).toBe(MGIK_SUB_HEADER_SIZE + 4);
    });
  });

  describe("buildActivateLayer", () => {
    it("encodes layer ID", () => {
      const payload = buildActivateLayer(SUB_MAGIC, 0, 42);
      expect(readCmd(payload)).toBe(CMD_ACTIVATE_LAYER);
      expect(payload.readUInt32BE(MGIK_SUB_HEADER_SIZE + 4)).toBe(42);
    });
  });

  describe("buildMud", () => {
    it("builds arbitrary MUD with payload", () => {
      const extra = Buffer.from([0x01, 0x02]);
      const payload = buildMud(SUB_MAGIC, 0, 999, extra);
      expect(readCmd(payload)).toBe(999);
      expect(payload[MGIK_SUB_HEADER_SIZE + 4]).toBe(0x01);
      expect(payload[MGIK_SUB_HEADER_SIZE + 5]).toBe(0x02);
    });

    it("builds MUD without payload", () => {
      const payload = buildMud(SUB_MAGIC, 0, 999);
      expect(payload.length).toBe(MGIK_SUB_HEADER_SIZE + 4);
    });
  });
});

describe("parseLayerConfiguration", () => {
  it("parses a full layer configuration", () => {
    // Build a mock LayerConfiguration payload
    const buf = Buffer.alloc(128);
    let off = 0;
    buf.writeUInt32BE(0x12c, off); off += 4; // cmd
    buf.writeUInt32BE(7, off); off += 4; // id
    buf.writeUInt32BE(1920, off); off += 4; // width
    buf.writeUInt32BE(1080, off); off += 4; // height
    buf.writeFloatBE(0.0, off); off += 4; // posX
    buf.writeFloatBE(0.0, off); off += 4; // posY
    buf.writeFloatBE(1.0, off); off += 4; // depth
    buf.writeUInt32BE(0, off); off += 4; // type = PANEL_APP

    // Strings: appName, layerName, serial, pkg
    const strings = ["MyApp", "main", "SERIAL123", "com.test.app"];
    for (const s of strings) {
      const raw = Buffer.from(s);
      buf.writeUInt32BE(raw.length, off); off += 4;
      raw.copy(buf, off); off += raw.length;
      off += (4 - (raw.length % 4)) % 4;
    }

    const result = parseLayerConfiguration(buf.subarray(0, off));
    expect(result).not.toBeNull();
    expect(result!.id).toBe(7);
    expect(result!.width).toBe(1920);
    expect(result!.height).toBe(1080);
    expect(result!.depth).toBeCloseTo(1.0);
    expect(result!.type).toBe(0);
    expect(result!.typeName).toBe("PANEL_APP");
    expect(result!.app).toBe("MyApp");
    expect(result!.layer).toBe("main");
    expect(result!.serial).toBe("SERIAL123");
    expect(result!.pkg).toBe("com.test.app");
  });

  it("returns null for too-short payload", () => {
    expect(parseLayerConfiguration(Buffer.alloc(16))).toBeNull();
  });

  it("handles unknown layer type", () => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32BE(0x12c, 0);
    buf.writeUInt32BE(1, 4);
    buf.writeUInt32BE(800, 8);
    buf.writeUInt32BE(600, 12);
    buf.writeUInt32BE(99, 28); // unknown type

    const result = parseLayerConfiguration(buf);
    expect(result).not.toBeNull();
    expect(result!.typeName).toBe("UNKNOWN(99)");
  });
});
