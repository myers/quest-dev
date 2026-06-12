/**
 * Daemon process entry point.
 * Starts the unified HTTP server, manages lifecycle, and records its presence
 * in the per-serial registry (keyed on the device's hardware serial).
 */

import { getBatteryInfo, setAdbDevice } from "../utils/adb.js";
import { loadConfig } from "../utils/config.js";
import { trackUnpluggedDuration, shouldExitOnUnplug } from "../commands/stay-awake.js";
import { verbose } from "../utils/verbose.js";
import { cdpPortForSerial } from "../utils/device-id.js";
import { StayAwakeManager } from "./stay-awake-manager.js";
import { LogcatManager } from "./logcat-manager.js";
import { CastManager } from "./cast-manager.js";
import { createDaemonServer } from "./server.js";
import { writeRegistry, removeRegistry, type DaemonRecord } from "./registry.js";

// Cast listen port the daemon advertises until a later task makes it dynamic.
// Mirrors CastManager's fallback default (cast-manager.ts: `opts.listenPort ?? 4445`).
const DEFAULT_CAST_PORT = 4445;

export interface StartDaemonOptions {
  /** Device hardware serial (stable identity / registry key). Resolved by the client. */
  serial: string;
  /** Current ADB transport address (IP:port or serial). Resolved by the client. */
  address: string;
  /** Requested HTTP port. Defaults to 0 (OS-assigned) when undefined. */
  port?: number;
  host?: string;
  idleTimeout?: number;
  lowBattery?: number;
  unpluggedTimeout?: number;
}

export async function startDaemon(opts: StartDaemonOptions): Promise<void> {
  const { serial, address } = opts;
  const config = loadConfig();
  const idleTimeout = opts.idleTimeout ?? config.idleTimeout ?? 300000;
  const lowBattery = opts.lowBattery ?? config.lowBattery ?? 10;
  const unpluggedTimeout = opts.unpluggedTimeout ?? config.unpluggedTimeout ?? 300000;
  const port = opts.port ?? 0;
  const host = opts.host ?? config.host ?? "127.0.0.1";
  setAdbDevice(address);

  const cdpPort = cdpPortForSerial(serial);

  const stayAwake = new StayAwakeManager();
  const logcat = new LogcatManager();
  const castManager = new CastManager(address);

  // Idle timer. When the daemon goes `idleTimeout` ms with no activity it
  // shuts down — which releases stay-awake and lets the Quest power off.
  // That auto-off is INTENTIONAL: agent-driven workflows idle for long
  // stretches, and leaving the headset powered adds physical wear. Do NOT
  // "fix" a daemon-dies-mid-task bug by disabling or greatly extending
  // this timeout. The correct fix is for an active session to mark itself
  // alive — send SIGUSR1 (see the `quest-dev ping` command), which the
  // handler below routes to resetIdleTimer().
  let idleHandle: NodeJS.Timeout | null = null;

  const resetIdleTimer = () => {
    if (idleHandle) clearTimeout(idleHandle);
    idleHandle = setTimeout(() => {
      console.log("Idle timeout reached, shutting down daemon...");
      shutdown();
    }, idleTimeout);
  };

  // Battery monitor
  let batteryInterval: NodeJS.Timer | null = null;
  let lastReportedBucket = -1;

  const BATTERY_POLL_MS = 60000;
  let unpluggedMs = 0; // accumulated time spent unplugged across polls

  const startBatteryMonitor = () => {
    batteryInterval = setInterval(async () => {
      try {
        const battery = await getBatteryInfo();
        const currentBucket = Math.floor(battery.level / 5) * 5;
        if (currentBucket !== lastReportedBucket) {
          verbose(`Battery: ${battery.level}% ${battery.state}`);
          lastReportedBucket = currentBucket;
        }
        if (battery.level <= lowBattery && battery.state === "not charging") {
          console.log(
            `Battery critically low (${battery.level}%), shutting down daemon...`,
          );
          shutdown();
          return;
        }

        // Exit on a sustained unplug (a brief unplug under the grace window is forgiven).
        unpluggedMs = trackUnpluggedDuration(unpluggedMs, battery.state, BATTERY_POLL_MS);
        if (shouldExitOnUnplug(unpluggedMs, unpluggedTimeout)) {
          console.log(
            `Unplugged for ${Math.round(unpluggedMs / 1000)}s, shutting down daemon...`,
          );
          shutdown();
        }
      } catch {
        // Device might be unavailable
      }
    }, BATTERY_POLL_MS);
  };

  // Cleanup + shutdown
  let shutdownInProgress = false;

  const shutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    console.log("Daemon shutting down...");

    if (idleHandle) clearTimeout(idleHandle);
    if (batteryInterval) clearInterval(batteryInterval as NodeJS.Timeout);

    // Stop cast
    castManager.cleanup();

    // Restore stay-awake
    stayAwake.cleanupSync();

    // Stop logcat
    logcat.cleanup();

    // Remove this daemon's registry record
    removeRegistry(serial);

    console.log("Daemon stopped.");
    process.exit(0);
  };

  // Signal handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // SIGUSR1 marks the daemon active and resets the idle timer. Sent by
  // Claude Code hooks and by `quest-dev ping` — which long-running test
  // sessions call periodically so the daemon survives the run.
  process.on("SIGUSR1", () => {
    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] Activity detected, resetting idle timer`);
    resetIdleTimer();
  });

  // Start server
  const server = await createDaemonServer({
    port,
    host,
    stayAwake,
    logcat,
    castManager,
    onActivity: resetIdleTimer,
    onShutdown: () => shutdown(),
  });

  // Get the actual bound port (Fastify resolves :0 to an OS-assigned port).
  const bound = server.server.address();
  const boundPort =
    typeof bound === "object" && bound ? bound.port : port;

  // Record this daemon in the per-serial registry.
  const record: DaemonRecord = {
    pid: process.pid,
    port: boundPort,
    serial,
    address,
    cdpPort,
    castPort: DEFAULT_CAST_PORT,
    startedAt: new Date().toISOString(),
  };
  writeRegistry(record);

  console.log(
    `quest-dev daemon started (PID: ${process.pid}, port: ${boundPort}, serial: ${serial})`,
  );
  console.log(
    `Idle timeout: ${Math.round(idleTimeout / 1000)}s, low battery: ${lowBattery}%, ` +
      `unplugged exit: ${unpluggedTimeout > 0 ? `${Math.round(unpluggedTimeout / 1000)}s` : "off"}`,
  );

  // Start idle timer + battery monitor
  resetIdleTimer();
  startBatteryMonitor();

  // Keep process alive
  await new Promise<void>((resolve) => {
    process.on("exit", () => resolve());
  });
}
