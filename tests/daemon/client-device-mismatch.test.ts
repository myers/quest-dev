import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { discoverDaemon } from "../../src/daemon/client.js";
import {
  writeRegistry,
  readRegistry,
  type DaemonRecord,
} from "../../src/daemon/registry.js";

/**
 * The former single-daemon "device mismatch" guard is obsolete: daemons are now
 * keyed on the device's hardware serial, so two devices have independent
 * registry files and can never collide. What still matters is that
 * `discoverDaemon(serial)`:
 *   - returns a live record (PID alive), and
 *   - treats a stale record (PID dead) as absent, cleaning it up.
 */

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qd-client-"));
  saved = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

function record(over: Partial<DaemonRecord>): DaemonRecord {
  return {
    pid: process.pid, // this test process is, by definition, alive
    port: 40001,
    serial: "SERIAL_X",
    address: "127.0.0.1:5555",
    cdpPort: 9230,
    castPort: 4445,
    startedAt: "t",
    ...over,
  };
}

describe("discoverDaemon (per-serial)", () => {
  it("returns the record when its PID is alive", () => {
    const rec = record({ serial: "SERIAL_LIVE" });
    writeRegistry(rec);
    expect(discoverDaemon("SERIAL_LIVE")).toEqual(rec);
  });

  it("treats a dead-PID record as absent and removes it", () => {
    // PID 1 is init; process.kill(1, 0) from an unprivileged test throws ESRCH
    // or EPERM. Use a PID guaranteed not to be this process's signalable target.
    const deadPid = 2147483646; // implausibly high, not a live process
    writeRegistry(record({ serial: "SERIAL_STALE", pid: deadPid }));
    expect(discoverDaemon("SERIAL_STALE")).toBeNull();
    // stale file was cleaned up
    expect(readRegistry("SERIAL_STALE")).toBeNull();
  });

  it("returns null when no record exists for the serial", () => {
    expect(discoverDaemon("SERIAL_NONE")).toBeNull();
  });
});
