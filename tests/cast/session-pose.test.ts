import { describe, expect, it, vi } from "vitest";
import { CastSession } from "../../src/cast/session.js";
import {
  CMD_POSE,
  CMD_SET_PROPERTY,
  CMD_INPUT_FORWARDING_STATE,
  CMD_START_INPUT_FORWARDING,
  CMD_ACTIVATE_LAYER,
  createPoseState,
} from "@myerscarpenter/cast2-protocol";

/**
 * Bug: /cast/pose silently no-ops because the Quest stays in
 * INPUT_FWD_STATE=0 (compositor eye buffer). Fix: sendPose must call
 * ensureInputForwarding() to send the CAMERA-mode handshake before each
 * POSE message. ensureInputForwarding is idempotent — handshake should
 * only be sent once across multiple sendPose calls.
 */

// MGIK sub-header is 24 bytes; cmd is the next u32 BE.
const SUB_HEADER_SIZE = 24;
function cmdOf(payload: Buffer): number {
  return payload.readUInt32BE(SUB_HEADER_SIZE);
}

function makeConnectedSession(): {
  session: CastSession;
  sent: Buffer[];
} {
  const session = new CastSession();
  const sent: Buffer[] = [];

  // Force connected state without standing up real sockets.
  const s = session as unknown as {
    _connected: boolean;
    subMagic: number;
    sendXrsp: (payload: Buffer) => void;
  };
  s._connected = true;
  s.subMagic = 0x12345678;
  s.sendXrsp = (payload: Buffer) => {
    sent.push(payload);
  };

  return { session, sent };
}

describe("CastSession.sendPose CAMERA-mode handshake", () => {
  it("sends the four-message handshake before the first POSE", () => {
    const { session, sent } = makeConnectedSession();

    session.sendPose(createPoseState());

    const cmds = sent.map(cmdOf);
    expect(cmds).toEqual([
      CMD_SET_PROPERTY,
      CMD_INPUT_FORWARDING_STATE,
      CMD_START_INPUT_FORWARDING,
      CMD_ACTIVATE_LAYER,
      CMD_POSE,
    ]);

    // Stop the auto-started pose loop so the test exits cleanly.
    session.stopPoseLoop();
  });

  it("does not re-emit the handshake on subsequent sendPose calls", () => {
    const { session, sent } = makeConnectedSession();

    session.sendPose(createPoseState());
    sent.length = 0;
    session.sendPose(createPoseState());

    expect(sent.map(cmdOf)).toEqual([CMD_POSE]);

    session.stopPoseLoop();
  });
});
