/**
 * Quest cast command — streams video from Quest headset and serves
 * a REST API + web dashboard for remote interaction.
 *
 * Subsumes stay-awake functionality: manages test properties, idle timeout,
 * battery monitoring, and watchdog cleanup.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { checkADBPath, getBatteryInfo, formatBatteryInfo } from "../utils/adb.js";
import { loadPin, loadConfig } from "../utils/config.js";
import { execCommand } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import {
  buildSetPropertyArgs,
  setTestProperties,
  getTestProperties,
  formatTestProperties,
} from "../utils/test-properties.js";
import { CastSession } from "../cast/session.js";
import { createCastServer } from "../cast/server.js";

export interface CastCommandOptions {
  port?: number;
  listenPort?: number;
  pin?: string;
  idleTimeout?: number;
  lowBattery?: number;
  width?: number;
  height?: number;
  verbose?: boolean;
  open?: boolean;
}

const PID_FILE = `${os.homedir()}/.quest-dev-cast.pid`;

export async function castCommand(options: CastCommandOptions): Promise<void> {
  checkADBPath();

  // Check for connected devices
  try {
    const output = await execCommand("adb", ["devices"]);
    const lines = output.trim().split("\n").slice(1);
    const devices = lines.filter(
      (line) => line.trim() && !line.includes("List of devices"),
    );
    if (devices.length === 0) {
      console.error("Error: No ADB devices connected");
      process.exit(1);
    }
  } catch {
    console.error("Error: Failed to list ADB devices");
    process.exit(1);
  }

  // Load config
  const config = loadConfig();
  const port = options.port ?? 8080;
  const listenPort = options.listenPort ?? 4445;
  const idleTimeout = options.idleTimeout ?? config.idleTimeout ?? 300000;
  const lowBattery = options.lowBattery ?? config.lowBattery ?? 10;
  const width = options.width ?? 2064;
  const height = options.height ?? 1162;

  // PID file management — kill old instance
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf-8"));
    try {
      process.kill(existingPid, 0); // Check if running
      verbose(`Killing old cast instance (PID: ${existingPid})`);
      process.kill(existingPid, "SIGTERM");
      // Wait briefly for it to exit
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(existingPid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          break;
        }
      }
    } catch {
      // Not running
    }
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // Ignore
    }
  }

  // Write PID file
  try {
    fs.writeFileSync(PID_FILE, process.pid.toString());
  } catch {
    console.warn("Failed to write PID file");
  }

  // Get Quest IP from ADB
  let questIp: string;
  try {
    const devOutput = await execCommand("adb", ["devices"]);
    const devLines = devOutput.trim().split("\n").slice(1);
    const firstDevice = devLines.find((l) => l.includes("device"));
    if (!firstDevice) {
      console.error("Error: No authorized ADB device found");
      process.exit(1);
    }
    const deviceId = firstDevice.split("\t")[0].trim();
    // Try to get IP from device
    try {
      const ip = await execCommand("adb", [
        "-s", deviceId, "shell",
        "ip addr show wlan0 | grep 'inet ' | tr -s ' ' | cut -f3 -d' ' | cut -f1 -d/",
      ]);
      questIp = ip.trim();
      if (!questIp || questIp.includes("error")) {
        questIp = deviceId.split(":")[0]; // fallback to device ID
      }
    } catch {
      questIp = deviceId.split(":")[0];
    }
  } catch {
    console.error("Error: Failed to detect Quest device");
    process.exit(1);
  }

  // Enable stay-awake (test properties) if PIN available
  let pin: string | undefined;
  try {
    pin = loadPin(options.pin);
  } catch {
    // PIN not configured, skip stay-awake
  }

  if (pin) {
    try {
      const beforeProps = await getTestProperties();
      verbose("Current test properties:\n" + formatTestProperties(beforeProps));
      await setTestProperties(pin, true);
      console.log("Stay-awake enabled (guardian, dialogs, autosleep disabled)");
    } catch (error) {
      console.warn("Failed to enable stay-awake:", (error as Error).message);
      pin = undefined; // Don't try to restore on cleanup
    }
  }

  // Spawn watchdog for cleanup
  let watchdog: ChildProcess | null = null;
  if (pin) {
    try {
      watchdog = spawn(
        process.execPath,
        [
          process.argv[1],
          "stay-awake-watchdog",
          "--parent-pid", process.pid.toString(),
          "--pin", pin,
        ],
        { detached: true, stdio: "ignore" },
      );
      watchdog.unref();
    } catch {
      console.warn("Failed to spawn watchdog");
    }
  }

  // Create cast session
  const session = new CastSession({ listenPort, width, height });

  // Bind TCP first (auto-increments port on EADDRINUSE), then ADB setup, then wait for Quest
  try {
    await session.bind();
    if (session.listenPort !== listenPort) {
      console.log(`Port ${listenPort} in use, listening on ${session.listenPort}`);
    }
    await session.adbSetup(questIp);
    await session.start(questIp);
    console.log("Quest connected, casting active");
  } catch (error) {
    console.error("Failed to connect:", (error as Error).message);
    await cleanup(pin, watchdog);
    process.exit(1);
  }

  // Start HTTP server
  try {
    const resetIdleTimer = createIdleTimer(idleTimeout, () => {
      console.log("\nIdle timeout reached, exiting...");
      cleanup(pin, watchdog).then(() => process.exit(0));
    });

    const server = await createCastServer({
      port,
      session,
      onActivity: resetIdleTimer,
    });

    const url = `http://localhost:${port}/`;
    console.log(`HTTP server: ${url}`);
    console.log(`Screenshot:  http://localhost:${port}/screenshot`);
    console.log(`MJPEG:       http://localhost:${port}/stream`);
    console.log(`Status:      http://localhost:${port}/status`);

    if (options.open) {
      const openCmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "start"
        : "xdg-open";
      spawn(openCmd, [url], { detached: true, stdio: "ignore" }).unref();
    }
    console.log(
      `Idle timeout: ${Math.round(idleTimeout / 1000)}s, low battery: ${lowBattery}%`,
    );
    console.log("Press Ctrl-C to stop.");

    // SIGUSR1 resets idle timer
    process.on("SIGUSR1", () => {
      const now = new Date().toLocaleTimeString();
      console.log(`[${now}] Activity detected, resetting idle timer`);
      resetIdleTimer();
    });

    // Battery monitoring
    let lastReportedBucket = -1;
    try {
      const battery = await getBatteryInfo();
      console.log(`Battery: ${formatBatteryInfo(battery)}`);
      lastReportedBucket = Math.floor(battery.level / 5) * 5;
    } catch {
      // Ignore
    }

    const batteryInterval = setInterval(async () => {
      try {
        const battery = await getBatteryInfo();
        const currentBucket = Math.floor(battery.level / 5) * 5;
        if (options.verbose) {
          console.log(`Battery: ${formatBatteryInfo(battery)}`);
        } else if (currentBucket !== lastReportedBucket) {
          console.log(`Battery: ${formatBatteryInfo(battery)}`);
        }
        lastReportedBucket = currentBucket;

        if (battery.level <= lowBattery && battery.state === "not charging") {
          console.log(`\nBattery critically low (${battery.level}%), exiting...`);
          clearInterval(batteryInterval);
          await cleanup(pin, watchdog);
          process.exit(0);
        }
      } catch {
        // Ignore battery check failures
      }
    }, 60000);

    // Cleanup handlers
    const onExit = async () => {
      clearInterval(batteryInterval);
      await session.stop();
      await server.close();
      await cleanup(pin, watchdog);
      process.exit(0);
    };

    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);
    process.on("SIGHUP", onExit);

    // Keep process alive
    await new Promise<void>((resolve) => {
      process.on("exit", () => resolve());
    });
  } catch (error) {
    console.error("Server error:", (error as Error).message);
    await cleanup(pin, watchdog);
    process.exit(1);
  }
}

async function cleanup(
  pin: string | undefined,
  watchdog: ChildProcess | null,
): Promise<void> {
  if (watchdog) {
    try {
      watchdog.kill();
    } catch {
      // Already dead
    }
  }

  if (pin) {
    console.log("\nRestoring Quest settings...");
    try {
      const args = buildSetPropertyArgs(pin, false);
      execSync(`adb ${args.join(" ")}`, { stdio: "ignore" });
      console.log("Stay-awake disabled");
    } catch {
      console.error("Failed to restore settings");
    }
  }

  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
}

function createIdleTimer(
  timeoutMs: number,
  onTimeout: () => void,
): () => void {
  let handle: NodeJS.Timeout | null = null;

  const reset = () => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(onTimeout, timeoutMs);
  };

  reset();
  return reset;
}
