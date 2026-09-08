/**
 * Deploy handler for the daemon.
 * Extracts package name from APK, installs, launches, checks for crashes.
 */

import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { execCommand } from "../utils/exec.js";
import type { ExecResult } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import {
  adbArgs,
  ensureAdbHealthy,
  realAdbExec,
  waitForPanelComposited,
  type AdbExecRunner,
} from "../utils/adb.js";
import {
  resolvePortConflicts,
  type AdbCommandRunner,
} from "../utils/port-owners.js";
import type { StayAwakeManager } from "./stay-awake-manager.js";
import type { LogcatManager } from "./logcat-manager.js";

/**
 * Default debugging port to scan for conflicts. 15702 is Bevy BRP's
 * hard-coded HTTP port; other engines/frameworks bind different ports
 * (e.g. React Native Metro 8081, Flutter DDS dynamic). Override via the
 * `debuggingPort` option, the `debuggingPort` config key, or the
 * `--debugging-port` CLI flag.
 */
const DEFAULT_DEBUGGING_PORT = 15702;

export interface DeployOptions {
  apkPath: string;
  pin: string;
  crashWaitMs?: number;
  onEvent: (event: DeployEvent) => void;
  /**
   * Adb command runner for every plain `adb <args>` call deploy() makes —
   * the debugging-port conflict scan, the force-stop, and the launch.
   * Defaults to the real `adb` binary via adbArgs(); tests inject a mock.
   */
  adb?: AdbCommandRunner;
  /**
   * Adb runner for the calls that need the exit code as well as stdout: the
   * install (whose stderr streams incremental progress), the pidof liveness
   * probe, and waitForPanelComposited's dumpsys/logcat probes. Defaults to
   * the real `adb` binary; tests inject a fake so no path shells out.
   */
  adbExec?: AdbExecRunner;
  /**
   * Target package name. When supplied, skips APK package-name extraction.
   * Used by tests to drive the port-conflict path without a real APK.
   */
  targetPackage?: string;
  /**
   * TCP port to scan for conflicting LISTEN sockets. Defaults to 15702
   * (Bevy BRP). Set for other frameworks (React Native Metro 8081,
   * Flutter DDS, custom RPC servers, etc.).
   */
  debuggingPort?: number;
}

export interface InstallInfo {
  incremental: boolean;
  installSecs: number;
  apkSizeMB: number;
}

export type DeployResult =
  | { ok: true;  package: string; crashed: false; logcatFile: string; install?: InstallInfo }
  | { ok: false; package: string; crashed: true;  logcatFile: string; logcatLines?: string[]; error?: string }
  | { ok: false; package: string; crashed: false; error: string; logcatFile?: string };

export type DeployEvent =
  | { type: 'adb_health'; status: 'connecting' | 'reconnecting' | 'restarting_server' }
  | { type: 'adb_health'; status: 'recovered'; via: 'connect' | 'reconnect' | 'kill-server' }
  | { type: 'adb_health'; status: 'failed'; error: string }
  | { type: 'stay_awake'; status: 'enabling' | 'enabled' | 'failed'; error?: string }
  | { type: 'started'; package: string; apkSizeMB: number; incremental: boolean }
  | {
      type: 'port_conflict_resolved';
      port: number;
      stopped: Array<{ packageName: string; uid: number }>;
      skipped: Array<{ uid: number; packageName: string | null }>;
    }
  | { type: 'installed'; installSecs: number }
  | { type: 'launching' }
  | { type: 'crash_check'; waitMs: number }
  | ({ type: 'done' } & DeployResult);

/**
 * Extract package name from APK using aapt2 or aapt
 */
async function extractPackageName(apkPath: string): Promise<string> {
  for (const tool of ["aapt2", "aapt"]) {
    try {
      const output = await execCommand(tool, ["dump", "badging", apkPath]);
      const match = output.match(/package:\s*name='([^']+)'/);
      if (match) {
        return match[1];
      }
    } catch {
      verbose(`${tool} not found or failed, trying next`);
    }
  }

  throw new Error(
    "Cannot extract package name from APK. Install aapt2 (part of Android build-tools).",
  );
}

// No install-progress reporting: adb's only incremental trace is
// "MISSING BLOCK: reading file %d block %04d (in priority: %d of %d)" from
// packages/modules/adb/client/incremental_server.cpp, whose numbers are an
// index into the priority-block vector and that vector's size -- not blocks
// transferred and not the APK's block count. Any byte figure derived from it
// is fiction; measured 2026-09-08, a 129.1 MB APK reported "~16KB" one run and
// "~48KB" the next with identical bytes on the wire. See issue
// quest-dev-deploy-incremental-bytes-wrong.

/**
 * Run the full deploy sequence.
 */
export async function deploy(
  options: DeployOptions,
  stayAwake: StayAwakeManager,
  logcat: LogcatManager,
): Promise<void> {
  const {
    apkPath,
    crashWaitMs = 5000,
    pin,
    onEvent,
    adb = (args: string[]) => execCommand("adb", adbArgs(...args)),
    adbExec = realAdbExec,
  } = options;
  const absPath = resolve(apkPath);

  // Health-check ADB before doing anything. If the device is wedged, no
  // amount of stay-awake or install will succeed; fail fast with a clear
  // event the user can see.
  const health = await ensureAdbHealthy({
    onConnecting: () => onEvent({ type: 'adb_health', status: 'connecting' }),
    onReconnecting: () => onEvent({ type: 'adb_health', status: 'reconnecting' }),
    onRestartingServer: () => onEvent({ type: 'adb_health', status: 'restarting_server' }),
    onRecovered: (via) => onEvent({ type: 'adb_health', status: 'recovered', via }),
    onFailed: (error) => onEvent({ type: 'adb_health', status: 'failed', error }),
  });
  if (health.kind === 'failed') {
    onEvent({
      type: 'done',
      ok: false,
      package: '',
      crashed: false,
      error: `ADB unresponsive: ${health.error}`,
    });
    return;
  }

  // Keep Quest awake FIRST — before anything else touches ADB.
  // Large APK uploads over Wi-Fi ADB fail if the Quest sleeps mid-transfer.
  //
  // Unconditional: turnOn() is idempotent and verifies with GET_PROPERTY.
  // Skipping it when the daemon *believed* stay-awake was already on is what
  // let deploy exit 0 over a headset whose protections were still up.
  onEvent({ type: 'stay_awake', status: 'enabling' });
  try {
    await stayAwake.turnOn(pin);
    onEvent({ type: 'stay_awake', status: 'enabled' });
  } catch (error) {
    const message = (error as Error).message;
    onEvent({ type: 'stay_awake', status: 'failed', error: message });
    onEvent({
      type: 'done',
      ok: false,
      package: '',
      crashed: false,
      error: `Stay-awake failed: ${message}`,
    });
    return;
  }

  // Validate APK exists
  if (!existsSync(absPath)) {
    onEvent({ type: 'done', ok: false, package: "", crashed: false, error: `APK not found: ${absPath}` });
    return;
  }

  // Warn if APK is stale (older than 1 minute — probably deploying old code)
  const apkAge = Date.now() - statSync(absPath).mtimeMs;
  if (apkAge > 60_000) {
    const mins = Math.floor(apkAge / 60_000);
    const secs = Math.floor((apkAge % 60_000) / 1000);
    console.warn(`\n⚠️  APK is ${mins}m${secs}s old — you may be deploying stale code!\n`);
  }

  // Extract package name (or use the caller-provided override).
  let packageName: string;
  if (options.targetPackage) {
    packageName = options.targetPackage;
  } else {
    try {
      packageName = await extractPackageName(absPath);
    } catch (error) {
      onEvent({ type: 'done', ok: false, package: "", crashed: false, error: (error as Error).message });
      return;
    }
  }

  const apkSizeMB = parseFloat((statSync(absPath).size / 1_048_576).toFixed(1));
  const hasIdsig = existsSync(`${absPath}.idsig`);

  onEvent({ type: 'started', package: packageName, apkSizeMB, incremental: hasIdsig });

  // Detect and resolve orphan-app debugging-port conflicts. This catches
  // the scenario where a previously-launched app still holds the
  // debugging port (e.g. Bevy BRP 15702), so the freshly-deployed app
  // silently fails to rebind and clients end up waiting on the orphan's
  // possibly-suspended state.
  const debuggingPort = options.debuggingPort ?? DEFAULT_DEBUGGING_PORT;
  try {
    const report = await resolvePortConflicts({
      port: debuggingPort,
      targetPackage: packageName,
      adb,
    });
    if (report.stopped.length > 0 || report.skipped.length > 0) {
      onEvent({
        type: 'port_conflict_resolved',
        port: debuggingPort,
        stopped: report.stopped,
        skipped: report.skipped,
      });
    }
  } catch (error) {
    // Non-fatal: log via verbose, continue with the deploy.
    verbose(`port-conflict scan failed: ${(error as Error).message}`);
  }

  // Force-stop existing app
  try {
    await adb(["shell", "am", "force-stop", packageName]);
    verbose(`Force-stopped ${packageName}`);
  } catch {
    // App might not be running
  }

  // Install APK
  const installStart = Date.now();
  const installResult = await adbExec(["install", "-r", absPath]);
  const installSecs = parseFloat(((Date.now() - installStart) / 1000).toFixed(1));
  verbose("Install stdout:", installResult.stdout.trim());
  verbose("Install stderr:", installResult.stderr.trim());
  if (installResult.code !== 0) {
    const detail = [installResult.stdout.trim(), installResult.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    onEvent({
      type: 'done',
      ok: false,
      package: packageName,
      crashed: false,
      error: `Install failed (exit ${installResult.code}):\n${detail}`,
    });
    return;
  }
  const installInfo: InstallInfo = { incremental: hasIdsig, installSecs, apkSizeMB };
  onEvent({ type: 'installed', installSecs });

  // Start logcat capture (clears buffer first)
  await logcat.start();
  const logcatFile = logcat.status().file;
  if (!logcatFile) throw new Error("logcat started but no file created");

  onEvent({ type: 'launching' });
  try {
    // Try to launch via monkey (works for any app with a launcher activity)
    await adb([
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
    verbose(`Launched ${packageName}`);
  } catch (error) {
    onEvent({
      type: 'done',
      ok: false,
      package: packageName,
      crashed: false,
      logcatFile,
      error: `Launch failed: ${(error as Error).message}`,
    });
    return;
  }

  onEvent({ type: 'crash_check', waitMs: crashWaitMs });
  await new Promise((r) => setTimeout(r, crashWaitMs));

  // Check for crash in logcat
  const { crashed, lines, reason, matchedLine, matchedPattern } = logcat.scanForCrash(200, packageName);

  if (crashed) {
    const detail = [
      `Crash reason: ${reason ?? "unknown"}`,
      `Matched pattern: /${matchedPattern}/`,
      `Triggered by line: ${matchedLine}`,
    ].join("\n");
    onEvent({
      type: 'done',
      ok: false,
      package: packageName,
      crashed: true,
      logcatLines: lines,
      logcatFile,
      error: detail,
    });
    return;
  }

  // Verify process is still running
  const psResult = await adbExec(["shell", "pidof", packageName]);
  const pid = psResult.stdout.trim();
  const processAlive = psResult.code === 0 && pid.length > 0;

  if (!processAlive) {
    // Process died without obvious crash pattern
    const tail = logcat.readTail(100);
    onEvent({
      type: 'done',
      ok: false,
      package: packageName,
      crashed: true,
      logcatLines: tail,
      logcatFile,
      error: `Process not running (pidof exit=${psResult.code}, stdout="${pid}", stderr="${psResult.stderr.trim()}")`,
    });
    return;
  }

  // A panel the VR shell backgrounded is not a crash and its process stays
  // alive, so everything above passes while nothing is composited -- and for a
  // Bevy panel that reads as "BRP stopped responding", not as a failed deploy.
  const composited = await waitForPanelComposited(packageName, { adb: adbExec });
  if (!composited.ok) {
    onEvent({
      type: 'done',
      ok: false,
      package: packageName,
      crashed: false,
      logcatFile,
      error: composited.error,
    });
    return;
  }

  onEvent({
    type: 'done',
    ok: true,
    package: packageName,
    crashed: false,
    logcatFile,
    install: installInfo,
  });
}

/**
 * Test helper: collects events into an array. Returns the array; the caller
 * passes `collector.push` as the onEvent callback to deploy().
 */
export function collectDeployEvents(): {
  events: DeployEvent[];
  push: (e: DeployEvent) => void;
} {
  const events: DeployEvent[] = [];
  return { events, push: (e) => events.push(e) };
}
