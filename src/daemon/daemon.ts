/**
 * Daemon process entry point.
 * Starts the unified HTTP server, manages lifecycle, writes daemon.json.
 */

import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getBatteryInfo } from "../utils/adb.js";
import { loadConfig } from "../utils/config.js";
import { verbose } from "../utils/verbose.js";
import { StayAwakeManager } from "./stay-awake-manager.js";
import { LogcatManager } from "./logcat-manager.js";
import { CastManager } from "./cast-manager.js";
import { createDaemonServer } from "./server.js";

export const DAEMON_DIR = join(homedir(), ".local", "share", "quest-dev");
export const DAEMON_JSON = join(DAEMON_DIR, "daemon.json");

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export async function startDaemon(port: number): Promise<void> {
  const config = loadConfig();
  const idleTimeout = config.idleTimeout ?? 300000;
  const lowBattery = config.lowBattery ?? 10;

  const stayAwake = new StayAwakeManager();
  const logcat = new LogcatManager();
  const castManager = new CastManager();

  // Idle timer
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
        }
      } catch {
        // Device might be unavailable
      }
    }, 60000);
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

    // Remove daemon.json
    try {
      unlinkSync(DAEMON_JSON);
    } catch {
      // Might already be gone
    }

    console.log("Daemon stopped.");
    process.exit(0);
  };

  // Signal handlers
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // SIGUSR1 resets idle timer (used by Claude Code hooks)
  process.on("SIGUSR1", () => {
    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] Activity detected, resetting idle timer`);
    resetIdleTimer();
  });

  // Start server
  const server = await createDaemonServer({
    port,
    stayAwake,
    logcat,
    castManager,
    onActivity: resetIdleTimer,
    onShutdown: () => shutdown(),
  });

  // Get the actual port (Fastify resolves it)
  const address = server.server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;

  // Write daemon.json
  mkdirSync(DAEMON_DIR, { recursive: true });
  const info: DaemonInfo = {
    pid: process.pid,
    port: actualPort,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(DAEMON_JSON, JSON.stringify(info, null, 2) + "\n");

  console.log(
    `quest-dev daemon started (PID: ${process.pid}, port: ${actualPort})`,
  );
  console.log(
    `Idle timeout: ${Math.round(idleTimeout / 1000)}s, low battery: ${lowBattery}%`,
  );

  // Start idle timer + battery monitor
  resetIdleTimer();
  startBatteryMonitor();

  // Keep process alive
  await new Promise<void>((resolve) => {
    process.on("exit", () => resolve());
  });
}
