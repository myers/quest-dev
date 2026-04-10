/**
 * Deploy handler for the daemon.
 * Extracts package name from APK, installs, launches, checks for crashes.
 */

import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { execCommand, execCommandFull, execCommandStreaming } from "../utils/exec.js";
import type { ExecResult } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import { adbArgs } from "../utils/adb.js";
import type { StayAwakeManager } from "./stay-awake-manager.js";
import type { LogcatManager } from "./logcat-manager.js";

export interface DeployOptions {
  apkPath: string;
  crashWaitMs?: number;
  pin?: string;
}

export interface InstallInfo {
  incremental: boolean;
  blocksTransferred?: number;
  totalBlocks?: number;
  bytesTransferred?: number;
  installSecs: number;
  apkSizeMB: number;
}

export type DeployResult =
  | { ok: true;  package: string; crashed: false; logcatFile: string; install?: InstallInfo }
  | { ok: false; package: string; crashed: true;  logcatFile: string; logcatLines?: string[]; error?: string }
  | { ok: false; package: string; crashed: false; error: string; logcatFile?: string };

/**
 * Extract package name from APK using aapt2 or aapt
 */
async function extractPackageName(apkPath: string): Promise<string> {
  // Try aapt2 first, then aapt
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

  // Fallback: use adb shell to parse via pm on device (after install)
  // But we need it before install, so try apkreader
  try {
    const ApkReader = (await import("adbkit-apkreader")).default;
    const reader = await ApkReader.open(apkPath);
    const manifest = await reader.readManifest();
    return manifest.package;
  } catch {
    throw new Error(
      "Cannot extract package name from APK. Install aapt2 (Android build-tools) or adbkit-apkreader.",
    );
  }
}

/**
 * Install APK with progress reporting for incremental installs.
 * When .idsig exists, uses ADB_TRACE=incremental to parse block transfer progress.
 */
interface InstallResult extends ExecResult {
  blocksTransferred: number;
  totalBlocks: number;
}

async function installWithProgress(
  absPath: string,
  adbArgsList: string[],
  hasIdsig: boolean,
): Promise<InstallResult> {
  if (!hasIdsig) {
    const result = await execCommandFull("adb", adbArgsList);
    return { ...result, blocksTransferred: 0, totalBlocks: 0 };
  }

  return new Promise((resolve) => {
    const env = { ...process.env, ADB_TRACE: "incremental" };
    const proc = spawn("adb", adbArgsList, { stdio: "pipe", env });

    let stdout = "";
    let stderr = "";
    let totalBlocks = 0;
    let lastReported = 0;
    let blocksTransferred = 0;

    if (proc.stdout) {
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;

        // Parse incremental progress: "in priority: 37904 of 52096"
        const matches = chunk.matchAll(/in priority: (\d+) of (\d+)/g);
        for (const match of matches) {
          const current = parseInt(match[1], 10);
          totalBlocks = parseInt(match[2], 10);
          blocksTransferred++;

          // Report every 10% or every 5000 blocks
          if (totalBlocks > 0 && current - lastReported >= totalBlocks * 0.1) {
            const pct = Math.round((current / totalBlocks) * 100);
            process.stdout.write(`\r  Streaming: ${current}/${totalBlocks} blocks (${pct}%)`);
            lastReported = current;
          }
        }
      });
    }

    proc.on("close", (code) => {
      if (totalBlocks > 0) {
        const kbTransferred = Math.round((blocksTransferred * 4096) / 1024);
        console.log(`\r  Transferred: ${blocksTransferred} blocks (~${kbTransferred}KB)`);
      }
      resolve({ stdout, stderr, code: code ?? 1, blocksTransferred, totalBlocks });
    });

    proc.on("error", (err) => {
      resolve({ stdout, stderr: err.message, code: 1, blocksTransferred: 0, totalBlocks: 0 });
    });
  });
}

/**
 * Run the full deploy sequence.
 */
export async function deploy(
  options: DeployOptions,
  stayAwake: StayAwakeManager,
  logcat: LogcatManager,
): Promise<DeployResult> {
  const { apkPath, crashWaitMs = 5000, pin } = options;
  const absPath = resolve(apkPath);

  // Keep Quest awake FIRST — before anything else touches ADB.
  // Large APK uploads over WiFi ADB fail if the Quest sleeps mid-transfer.
  if (!stayAwake.isEnabled && pin) {
    try {
      await stayAwake.enable(pin);
    } catch (error) {
      console.warn("Failed to enable stay-awake:", (error as Error).message);
    }
  }

  // Validate APK exists
  if (!existsSync(absPath)) {
    return { ok: false, package: "", crashed: false, error: `APK not found: ${absPath}` };
  }

  // Warn if APK is stale (older than 1 minute — probably deploying old code)
  const apkAge = Date.now() - statSync(absPath).mtimeMs;
  if (apkAge > 60_000) {
    const mins = Math.floor(apkAge / 60_000);
    const secs = Math.floor((apkAge % 60_000) / 1000);
    console.warn(`\n⚠️  APK is ${mins}m${secs}s old — you may be deploying stale code!\n`);
  }

  // Extract package name
  let packageName: string;
  try {
    packageName = await extractPackageName(absPath);
    console.log(`Package: ${packageName}`);
  } catch (error) {
    return {
      ok: false,
      package: "",
      crashed: false,
      error: (error as Error).message,
    };
  }

  // Force-stop existing app
  try {
    await execCommand("adb", adbArgs("shell", "am", "force-stop", packageName));
    verbose(`Force-stopped ${packageName}`);
  } catch {
    // App might not be running
  }

  // Install APK
  const apkSizeMB = (statSync(absPath).size / 1_048_576).toFixed(1);
  const hasIdsig = existsSync(`${absPath}.idsig`);
  console.log(`Installing APK (${apkSizeMB} MB)${hasIdsig ? " [incremental]" : ""}...`);
  const installStart = Date.now();
  const installResult = await installWithProgress(
    absPath,
    adbArgs("install", "-r", absPath),
    hasIdsig,
  );
  const installSecs = ((Date.now() - installStart) / 1000).toFixed(1);
  verbose("Install stdout:", installResult.stdout.trim());
  verbose("Install stderr:", installResult.stderr.trim());
  if (installResult.code !== 0) {
    const detail = [installResult.stdout.trim(), installResult.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    return {
      ok: false,
      package: packageName,
      crashed: false,
      error: `Install failed (exit ${installResult.code}):\n${detail}`,
    };
  }
  const apkSizeNum = parseFloat(apkSizeMB);
  const installInfo: InstallInfo = {
    incremental: hasIdsig,
    installSecs: parseFloat(installSecs),
    apkSizeMB: apkSizeNum,
    ...(installResult.totalBlocks > 0 ? {
      blocksTransferred: installResult.blocksTransferred,
      totalBlocks: installResult.totalBlocks,
      bytesTransferred: installResult.blocksTransferred * 4096,
    } : {}),
  };
  console.log(`APK installed (${installSecs}s)`);

  // Start logcat capture (clears buffer first)
  await logcat.start();
  const logcatFile = logcat.status().file;
  if (!logcatFile) throw new Error("logcat started but no file created");

  // Launch app
  console.log("Launching app...");
  try {
    // Try to launch via monkey (works for any app with a launcher activity)
    await execCommand("adb", adbArgs(
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ));
    verbose(`Launched ${packageName}`);
  } catch (error) {
    return {
      ok: false,
      package: packageName,
      crashed: false,
      logcatFile,
      error: `Launch failed: ${(error as Error).message}`,
    };
  }

  // Wait for potential crash
  console.log(`Waiting ${crashWaitMs}ms for crash check...`);
  await new Promise((r) => setTimeout(r, crashWaitMs));

  // Check for crash in logcat
  const { crashed, lines, reason, matchedLine, matchedPattern } = logcat.scanForCrash(200, packageName);

  if (crashed) {
    const detail = [
      `Crash reason: ${reason ?? "unknown"}`,
      `Matched pattern: /${matchedPattern}/`,
      `Triggered by line: ${matchedLine}`,
    ].join("\n");
    return {
      ok: false,
      package: packageName,
      crashed: true,
      logcatLines: lines,
      logcatFile,
      error: detail,
    };
  }

  // Verify process is still running
  const psResult = await execCommandFull("adb", adbArgs(
    "shell",
    "pidof",
    packageName,
  ));
  const pid = psResult.stdout.trim();
  const processAlive = psResult.code === 0 && pid.length > 0;

  if (!processAlive) {
    // Process died without obvious crash pattern
    const tail = logcat.readTail(100);
    return {
      ok: false,
      package: packageName,
      crashed: true,
      logcatLines: tail,
      logcatFile,
      error: `Process not running (pidof exit=${psResult.code}, stdout="${pid}", stderr="${psResult.stderr.trim()}")`,
    };
  }

  console.log(`Deploy successful: ${packageName} is running`);
  return { ok: true, package: packageName, crashed: false, logcatFile, install: installInfo };
}
