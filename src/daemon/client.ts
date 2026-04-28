/**
 * Daemon discovery + HTTP client for CLI commands.
 * Auto-starts daemon if needed, then calls HTTP endpoints.
 */

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { DAEMON_JSON, type DaemonInfo } from "./daemon.js";
import { loadConfig } from "../utils/config.js";
import { verbose } from "../utils/verbose.js";

const DEFAULT_PORT = 19872;

/** Check if a PID is alive */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read daemon.json and verify PID is alive */
export function discoverDaemon(): DaemonInfo | null {
  if (!existsSync(DAEMON_JSON)) {
    return null;
  }
  try {
    const info: DaemonInfo = JSON.parse(readFileSync(DAEMON_JSON, "utf-8"));
    if (isPidAlive(info.pid)) {
      return info;
    }
    verbose(`Stale daemon.json (PID ${info.pid} is dead), cleaning up`);
    try {
      unlinkSync(DAEMON_JSON);
    } catch {
      // Best effort
    }
  } catch {
    // Corrupt file
  }
  return null;
}

export interface SpawnDaemonOptions {
  port: number;
  device?: string;
  host?: string;
  idleTimeout?: number;
  lowBattery?: number;
}

/** Spawn daemon as a detached background process */
async function spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonInfo> {
  const args = [process.argv[1], "daemon", "--port", String(opts.port)];
  if (opts.device) {
    args.push("--device", opts.device);
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
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for daemon.json to appear (up to 5s)
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = discoverDaemon();
    if (info) {
      return info;
    }
  }

  throw new Error("Daemon failed to start (timed out waiting for daemon.json)");
}

/** Resolve daemon port from CLI flag → config → default */
export function resolvePort(cliPort?: number): number {
  if (cliPort) return cliPort;
  const config = loadConfig();
  return config.port ?? DEFAULT_PORT;
}

function printDaemonUrl(port: number, host: string = "127.0.0.1"): void {
  console.log(`Daemon: http://${host}:${port} (API: /help)`);
}

/** Resolve device from CLI flag → config */
export function resolveDevice(cliDevice?: string): string | undefined {
  if (cliDevice) return cliDevice;
  const config = loadConfig();
  return config.device;
}

/**
 * Thrown when the running daemon is bound to a different ADB device than
 * the one the caller requested via --device. CLI handlers should catch
 * this, print a helpful message, and exit non-zero.
 */
export class DaemonDeviceMismatchError extends Error {
  readonly bound: string;
  readonly requested: string;
  constructor(bound: string, requested: string) {
    super(`daemon is bound to ${bound} but --device requested ${requested}`);
    this.name = "DaemonDeviceMismatchError";
    this.bound = bound;
    this.requested = requested;
  }
}

/**
 * Decide whether a discovered daemon is acceptable for the requested
 * device. Returns ok=true to reuse the daemon, or ok=false with a
 * conflict description when the caller should error out.
 *
 * Reuse rules:
 * - both undefined → reuse
 * - daemon set, request undefined → reuse
 * - daemon undefined, request set → reuse (soft case: daemon is on
 *   adb's default device, which may or may not match)
 * - both set, equal → reuse
 * - both set, unequal → conflict
 */
export function checkDaemonDevice(
  daemonDevice: string | undefined,
  requestedDevice: string | undefined,
):
  | { ok: true }
  | { ok: false; bound: string; requested: string } {
  if (
    requestedDevice &&
    daemonDevice &&
    requestedDevice !== daemonDevice
  ) {
    return { ok: false, bound: daemonDevice, requested: requestedDevice };
  }
  return { ok: true };
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
}

/** Ensure daemon is running, starting it if needed. Returns connection info. */
export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<DaemonInfo> {
  const existing = discoverDaemon();
  if (existing) {
    const requestedDevice = resolveDevice(opts.device);
    const check = checkDaemonDevice(existing.device, requestedDevice);
    if (!check.ok) {
      throw new DaemonDeviceMismatchError(check.bound, check.requested);
    }
    verbose(`Daemon already running (PID: ${existing.pid}, port: ${existing.port})`);
    printDaemonUrl(existing.port);
    return existing;
  }

  const port = resolvePort(opts.port);
  const device = resolveDevice(opts.device);
  const host = resolveHost(opts.host);
  console.log("Starting quest-dev daemon...");
  const info = await spawnDaemon({ port, device, host, idleTimeout: opts.idleTimeout, lowBattery: opts.lowBattery });
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
