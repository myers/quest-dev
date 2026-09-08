import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Regression: a stalled cast session (video socket EOF -> running=false, but
 * still connected) could not be recovered.
 *   - /cast/start short-circuited on `isActive`, which only checked `connected`.
 *   - /cast/restart went through CastSession.restart(), which re-bound the TCP
 *     server but never re-ran adbSetup()/startCastService(), so the Quest was
 *     never told to reconnect and it timed out at 0/2.
 * Both paths must now run the full start sequence against the device.
 */

const sessions: FakeSession[] = [];

class FakeSession extends EventEmitter {
  connected = false;
  running = false;
  listenPort = 4445;
  width = 1024;
  height = 1024;
  frameCount = 0;
  byteCount = 0;
  fps = 0;
  elapsedSeconds = 0;
  eye = 1;
  poseLoopActive = false;
  pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  bind = vi.fn(async () => {});
  adbSetup = vi.fn(async (_device: string) => {});
  start = vi.fn(async (_device?: string) => {
    this.connected = true;
    this.running = true;
  });
  stop = vi.fn(async () => {
    this.connected = false;
    this.running = false;
  });
  getScreenshot = () => null;
  constructor() {
    super();
    sessions.push(this);
  }
}

vi.mock("../../src/cast/session.js", () => ({ CastSession: FakeSession }));
vi.mock("../../src/utils/casting-apk.js", () => ({
  ensureCastingInstalled: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/adb.js", () => ({
  checkADBPath: () => {},
  getAdbDevice: () => "TESTSERIAL",
}));
vi.mock("../../src/utils/exec.js", () => ({
  execCommand: vi.fn(async () => "List of devices attached\nTESTSERIAL\tdevice\n"),
}));

const { CastManager } = await import("../../src/daemon/cast-manager.js");

describe("stalled cast session recovery", () => {
  beforeEach(() => {
    sessions.length = 0;
  });

  it("reports a stalled session as inactive so /cast/start restarts it", async () => {
    const mgr = new CastManager("192.168.42.152:5555");
    await mgr.start();
    expect(mgr.isActive).toBe(true);

    // Video socket EOF: still connected, no longer running.
    sessions[0].running = false;
    expect(mgr.isActive).toBe(false);

    // ...and start() must not short-circuit on its own duplicate guard either.
    await mgr.start();
    expect(sessions).toHaveLength(2);
    expect(sessions[1].start).toHaveBeenCalledWith("TESTSERIAL");
    mgr.cleanup();
  });

  it("restart re-runs adbSetup and starts the cast service on the device", async () => {
    const mgr = new CastManager("192.168.42.152:5555");
    await mgr.start();
    sessions[0].running = false;

    await mgr.restart();

    expect(sessions).toHaveLength(2);
    expect(sessions[0].stop).toHaveBeenCalled();
    // The fresh session must be told about the device on both calls — that is
    // what re-applies `adb reverse` and re-triggers the Quest casting service.
    expect(sessions[1].adbSetup).toHaveBeenCalledWith("TESTSERIAL");
    expect(sessions[1].start).toHaveBeenCalledWith("TESTSERIAL");
    expect(mgr.isActive).toBe(true);
    mgr.cleanup();
  });
});
