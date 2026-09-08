/**
 * Daemon discovery + HTTP client for CLI commands.
 * Auto-starts daemon if needed, then calls HTTP endpoints.
 */

import { spawn } from "node:child_process";
import {
  readRegistry,
  removeRegistry,
  type DaemonRecord,
} from "./registry.js";
import { resolveDevice as resolveDeviceFull } from "./resolve.js";
import { loadConfig } from "../utils/config.js";
import { verbose } from "../utils/verbose.js";
import { getBuildId } from "../utils/version.js";

/**
 * Connection info the rest of the CLI consumes. The per-serial registry record
 * is a superset of the old DaemonInfo (it carries `pid` + `port`), so we reuse
 * it directly as the daemon handle.
 */
export type DaemonInfo = DaemonRecord;

/** Check if a PID is alive */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Look up a live daemon for the given serial. Returns the record if its PID is
 * alive, otherwise cleans up the stale record and returns null.
 */
export function discoverDaemon(serial: string): DaemonRecord | null {
  const record = readRegistry(serial);
  if (!record) return null;
  if (isPidAlive(record.pid)) return record;
  verbose(`Stale daemon registry for ${serial} (PID ${record.pid} is dead), cleaning up`);
  removeRegistry(serial);
  return null;
}

/**
 * Mark the daemon active by sending it SIGUSR1, which its handler routes
 * to resetIdleTimer(). Long-running sessions call this (via `quest-dev
 * ping`) so the daemon survives a run it would otherwise idle out of.
 *
 * Returns "sent" when the signal was delivered, and "gone" when the PID no
 * longer exists (ESRCH) — a registry record whose daemon exited after the
 * caller's liveness check is an ordinary race, not a fault, so it is a return
 * value rather than a throw. Nothing else is caught: EPERM cannot reach here
 * through discoverDaemon(), whose isPidAlive() already treats an unsignalable
 * PID as dead.
 */
export function sendDaemonPing(info: Pick<DaemonInfo, "pid">): "sent" | "gone" {
  try {
    process.kill(info.pid, "SIGUSR1");
    return "sent";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    throw err;
  }
}

/**
 * Resolve the device referenced by `cliDevice` to its serial and return a live
 * daemon record for it, or null if the device can't be resolved or no live
 * daemon exists. Never throws — intended for best-effort paths (stop, --off,
 * config warnings) that must not fail when no device is connected.
 */
export async function discoverDaemonForDevice(
  cliDevice?: string,
): Promise<DaemonRecord | null> {
  let serial: string;
  try {
    ({ serial } = await resolveDeviceFull(cliDevice));
  } catch {
    return null;
  }
  return discoverDaemon(serial);
}

export interface SpawnDaemonOptions {
  serial: string;
  address: string;
  /** Only forwarded when the user explicitly set a port (so default binds :0). */
  port?: number;
  host?: string;
  idleTimeout?: number;
  lowBattery?: number;
  unpluggedTimeout?: number;
}

/** Spawn daemon as a detached background process, keyed on serial. */
async function spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonRecord> {
  const args = [
    process.argv[1],
    "daemon",
    "--serial",
    opts.serial,
    "--address",
    opts.address,
  ];
  // Only pass --port when explicitly requested; otherwise the daemon binds :0.
  if (opts.port !== undefined) {
    args.push("--port", String(opts.port));
  }
  if (opts.host) {
    args.push("--host", opts.host);
  }
  if (opts.idleTimeout !== undefined) {
    args.push("--idle-timeout", String(opts.idleTimeout));
  }
  if (opts.lowBattery !== undefined) {
    args.push("--low-battery", String(opts.lowBattery));
  }
  if (opts.unpluggedTimeout !== undefined) {
    args.push("--unplugged-timeout", String(opts.unpluggedTimeout));
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });

  // Detect an immediate crash (bad args, bind failure, throw before
  // writeRegistry). The exit handler fires for an early death even though we
  // unref() to keep the daemon detached once it survives startup.
  let earlyExit: number | null = null;
  child.on("exit", (code) => {
    earlyExit = code;
  });
  child.unref();

  // Wait for the registry record to appear (up to 5s). Only accept a record
  // whose PID is alive, so a stale predecessor file (DEAD pid) isn't mistaken
  // for the freshly-spawned daemon.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (earlyExit !== null) {
      throw new Error(
        `Daemon process exited with code ${earlyExit} before registering (check the device is reachable and the port is free)`,
      );
    }
    const record = readRegistry(opts.serial);
    if (record && isPidAlive(record.pid)) return record;
  }

  throw new Error(
    `Daemon failed to start (timed out waiting for registry record for ${opts.serial})`,
  );
}

function printDaemonUrl(port: number, host: string = "127.0.0.1"): void {
  console.log(`Daemon: http://${host}:${port} (API: /help)`);
}

/** Resolve host from CLI flag → config → default */
export function resolveHost(cliHost?: string): string {
  if (cliHost) return cliHost;
  const config = loadConfig();
  return config.host ?? "127.0.0.1";
}

export interface EnsureDaemonOptions {
  port?: number;
  device?: string;
  host?: string;
  idleTimeout?: number;
  lowBattery?: number;
  unpluggedTimeout?: number;
}

/**
 * Build id a /status body identifies itself by: its `build` stamp, else its
 * bare `version` (a daemon started before build stamps existed — which, being
 * older code than any CLI that asks, is stale by definition).
 */
export function daemonBuildId(body: { version?: unknown; build?: unknown }): string | null {
  if (typeof body.build === "string") return body.build;
  if (typeof body.version === "string") return body.version;
  return null;
}

/** Fetch the running daemon's build id, or null if unavailable. */
async function fetchDaemonBuild(info: DaemonInfo): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/status`);
    if (!r.ok) return null;
    return daemonBuildId((await r.json()) as { version?: unknown; build?: unknown });
  } catch {
    return null;
  }
}

/** Ask the daemon to shut down, then wait until its registry record is gone (PID dead). */
async function stopDaemonAndWait(info: DaemonRecord): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: "POST" });
  } catch {
    // Daemon may have already died; fall through to wait.
  }
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (readRegistry(info.serial) === null) return;
    if (!isPidAlive(info.pid)) {
      removeRegistry(info.serial);
      return;
    }
  }
  throw new Error(
    `Daemon (PID ${info.pid}) did not exit after /shutdown; remove its registry record for ${info.serial} manually if needed`,
  );
}

/**
 * Ensure a daemon is running for the requested device, starting it if needed.
 * Resolves the device's stable serial first, then looks up (or spawns) the
 * per-serial daemon. Returns the registry record.
 */
export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<DaemonRecord> {
  const cliBuild = getBuildId();
  const { address, serial } = await resolveDeviceFull(opts.device);

  let existing = discoverDaemon(serial);
  if (existing) {
    // If the device moved to a new transport address, do NOT rewrite the
    // record here. The running daemon owns its record and is bound to the
    // address it started with (it captured setAdbDevice/CastManager at
    // startup); advertising a new address the daemon isn't using is
    // misleading and races with the daemon's own shutdown removeRegistry. A
    // transport change requires restarting the daemon (handled by a later
    // task that adds daemon transport re-binding). Reuse `existing` as-is.
    const daemonBuild = await fetchDaemonBuild(existing);
    if (daemonBuild !== null && daemonBuild !== cliBuild) {
      console.log(
        `Daemon is build ${daemonBuild} but CLI is build ${cliBuild}, restarting daemon...`,
      );
      await stopDaemonAndWait(existing);
      existing = null;
    } else {
      verbose(`Daemon already running (PID: ${existing.pid}, port: ${existing.port})`);
      printDaemonUrl(existing.port);
      return existing;
    }
  }

  const host = resolveHost(opts.host);
  console.log("Starting quest-dev daemon...");
  const info = await spawnDaemon({
    serial,
    address,
    // Only forward an explicit --port; otherwise the daemon binds :0.
    port: opts.port,
    host,
    idleTimeout: opts.idleTimeout,
    lowBattery: opts.lowBattery,
    unpluggedTimeout: opts.unpluggedTimeout,
  });
  printDaemonUrl(info.port, host);
  return info;
}

/** Make an HTTP request to the daemon */
export async function daemonFetch(
  info: DaemonInfo,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = `http://127.0.0.1:${info.port}${path}`;
  const fetchOptions: RequestInit = {
    method: options?.method ?? "GET",
  };

  if (options?.body !== undefined) {
    fetchOptions.method = "POST";
    fetchOptions.headers = { "Content-Type": "application/json" };
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  return response.json();
}

/** Convenience: ensure daemon + fetch */
export async function daemonRequest(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<unknown> {
  const info = await ensureDaemon();
  return daemonFetch(info, path, options);
}

/**
 * Stream an NDJSON response from the daemon as an async generator.
 * Each yielded value is one parsed JSON object from the stream.
 *
 * If the daemon returns plain JSON (e.g. a validation 400), the entire
 * response body is parsed and yielded as a single value, then the
 * generator returns. This means consumers always see a sequence of
 * "events" regardless of which response shape they got.
 */
export async function* daemonFetchNdjson<T>(
  info: DaemonInfo,
  path: string,
  body: unknown,
): AsyncGenerator<T> {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-ndjson")) {
    if (ct.includes("application/json")) {
      yield (await response.json()) as T;
      return;
    }
    const text = await response.text();
    throw new Error(
      `Unexpected response from ${path} (HTTP ${response.status}, Content-Type: ${ct || "none"}): ${text.slice(0, 200)}`,
    );
  }

  if (!response.body) {
    throw new Error(`NDJSON response from ${path} had no body`);
  }

  const parseLine = (line: string): T => {
    try {
      return JSON.parse(line) as T;
    } catch (err) {
      throw new Error(
        `Invalid NDJSON line from ${path}: ${(err as Error).message} — line: ${line.slice(0, 200)}`,
      );
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield parseLine(line);
    }
  }
  if (buf.trim()) yield parseLine(buf.trim());
}
