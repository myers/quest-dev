/**
 * Deploy handler for the daemon.
 * Extracts package name from APK, installs, launches, checks for crashes.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execCommand, execCommandFull } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import { adbArgs } from "../utils/adb.js";
import type { StayAwakeManager } from "./stay-awake-manager.js";
import type { LogcatManager } from "./logcat-manager.js";

export interface DeployOptions {
  apkPath: string;
  crashWaitMs?: number;
  pin?: string;
}

export interface DeployResult {
  ok: boolean;
  package: string;
  crashed: boolean;
  logcatLines?: string[];
  logcatFile?: string;
  error?: string;
}

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
 * Run the full deploy sequence.
 */
export async function deploy(
  options: DeployOptions,
  stayAwake: StayAwakeManager,
  logcat: LogcatManager,
): Promise<DeployResult> {
  const { apkPath, crashWaitMs = 5000, pin } = options;
  const absPath = resolve(apkPath);

  // Validate APK exists
  if (!existsSync(absPath)) {
    return { ok: false, package: "", crashed: false, error: `APK not found: ${absPath}` };
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

  // Enable stay-awake on first deploy (lazy)
  if (!stayAwake.isEnabled && pin) {
    try {
      await stayAwake.enable(pin);
    } catch (error) {
      console.warn("Failed to enable stay-awake:", (error as Error).message);
    }
  }

  // Force-stop existing app
  try {
    await execCommand("adb", adbArgs("shell", "am", "force-stop", packageName));
    verbose(`Force-stopped ${packageName}`);
  } catch {
    // App might not be running
  }

  // Install APK
  console.log("Installing APK...");
  try {
    const installOutput = await execCommand("adb", adbArgs("install", "-r", absPath));
    verbose("Install output:", installOutput.trim());
    console.log("APK installed");
  } catch (error) {
    return {
      ok: false,
      package: packageName,
      crashed: false,
      error: `Install failed: ${(error as Error).message}`,
    };
  }

  // Start logcat capture (clears buffer first)
  await logcat.start();
  const logcatFile = logcat.status().file ?? undefined;

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
  const { crashed, lines } = logcat.scanForCrash();

  if (crashed) {
    console.log(`CRASH DETECTED in ${packageName}`);
    return {
      ok: false,
      package: packageName,
      crashed: true,
      logcatLines: lines,
      logcatFile,
    };
  }

  // Verify process is still running
  const psResult = await execCommandFull("adb", adbArgs(
    "shell",
    "pidof",
    packageName,
  ));
  const processAlive = psResult.code === 0 && psResult.stdout.trim().length > 0;

  if (!processAlive) {
    // Process died without obvious crash pattern
    const tail = logcat.readTail(100);
    return {
      ok: false,
      package: packageName,
      crashed: true,
      logcatLines: tail,
      logcatFile,
      error: "Process exited (no crash pattern detected but process not running)",
    };
  }

  console.log(`Deploy successful: ${packageName} is running`);
  return { ok: true, package: packageName, crashed: false, logcatFile };
}
