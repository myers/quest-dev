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

/** Spawn daemon as a detached background process */
async function spawnDaemon(port: number): Promise<DaemonInfo> {
  const child = spawn(
    process.execPath,
    [process.argv[1], "daemon", "--port", String(port)],
    {
      detached: true,
      stdio: "ignore",
    },
  );
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

/** Ensure daemon is running, starting it if needed. Returns connection info. */
export async function ensureDaemon(cliPort?: number): Promise<DaemonInfo> {
  const existing = discoverDaemon();
  if (existing) {
    verbose(`Daemon already running (PID: ${existing.pid}, port: ${existing.port})`);
    return existing;
  }

  const port = resolvePort(cliPort);
  console.log("Starting quest-dev daemon...");
  return spawnDaemon(port);
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
