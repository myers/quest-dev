import { describe, expect, it } from "vitest";
import {
  checkDaemonDevice,
  DaemonDeviceMismatchError,
} from "../../src/daemon/client.js";

/**
 * Bug: `quest-dev deploy --device X` silently runs against whatever
 * device the already-running daemon was bound to, ignoring --device.
 * Fix: ensureDaemon delegates the daemon/request device comparison to
 * checkDaemonDevice, then throws DaemonDeviceMismatchError on conflict.
 *
 * The decision matrix from the design doc:
 *
 * | daemon device | requested device | result        |
 * |---------------|------------------|---------------|
 * | undefined     | undefined        | reuse         |
 * | undefined     | set              | reuse (soft)  |
 * | set           | undefined        | reuse         |
 * | set, equal    | set, equal       | reuse         |
 * | set, A        | set, B           | conflict      |
 */
describe("checkDaemonDevice", () => {
  it("conflicts when daemon=A and requested=B", () => {
    const r = checkDaemonDevice("A", "B");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bound).toBe("A");
      expect(r.requested).toBe("B");
    }
  });

  it("reuses when both set and equal", () => {
    expect(checkDaemonDevice("A", "A")).toEqual({ ok: true });
  });

  it("reuses when daemon set and requested undefined", () => {
    expect(checkDaemonDevice("A", undefined)).toEqual({ ok: true });
  });

  it("reuses when daemon undefined and requested set (soft case)", () => {
    expect(checkDaemonDevice(undefined, "A")).toEqual({ ok: true });
  });

  it("reuses when both undefined", () => {
    expect(checkDaemonDevice(undefined, undefined)).toEqual({ ok: true });
  });
});

describe("DaemonDeviceMismatchError", () => {
  it("carries bound + requested and mentions both in its message", () => {
    const e = new DaemonDeviceMismatchError("A", "B");
    expect(e.bound).toBe("A");
    expect(e.requested).toBe("B");
    expect(e.name).toBe("DaemonDeviceMismatchError");
    expect(e.message).toContain("A");
    expect(e.message).toContain("B");
  });
});
