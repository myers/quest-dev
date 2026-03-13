/**
 * Casting APK extraction and installation utilities.
 * The debug APK (com.oculus.magicislandcastingservice.debug.apk) is required
 * on the Quest for casting. It ships inside Meta Quest Developer Hub (MQDH).
 */

import { existsSync, mkdirSync, statSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { execCommand } from "./exec.js";
import { verbose } from "./verbose.js";

const CASTING_PKG = "com.oculus.magicislandcastingservice";
const APK_FILENAME = "com.oculus.magicislandcastingservice.debug.apk";
const APK_DIR = join(homedir(), ".local", "share", "quest-dev");
export const CASTING_APK_PATH = join(APK_DIR, APK_FILENAME);

/** Path inside the NSIS-extracted MQDH where the APK lives */
const NSIS_APK_REL = "resources/bin/Casting/Resources/" + APK_FILENAME;

/**
 * Extract the debug casting APK from a MQDH installer (.exe.zip, .exe, or pre-extracted dir).
 * Uses 7z to crack open the NSIS installer.
 */
export async function extractCastingApk(source: string): Promise<string> {
  mkdirSync(APK_DIR, { recursive: true });

  const stat = statSync(source);
  let searchDir: string;

  if (stat.isDirectory()) {
    searchDir = source;
  } else if (source.endsWith(".zip")) {
    // .exe.zip — extract zip first, then NSIS
    const tmpZip = join(APK_DIR, "mqdh-zip-tmp");
    rmSync(tmpZip, { recursive: true, force: true });
    execFileSync("7z", ["x", `-o${tmpZip}`, source, "-y"], { stdio: "pipe" });
    const exe = readdirSync(tmpZip).find((f) => f.endsWith(".exe"));
    if (!exe) {
      throw new Error("No .exe found inside zip");
    }
    searchDir = extractNsis(join(tmpZip, exe));
    rmSync(tmpZip, { recursive: true, force: true });
  } else if (source.endsWith(".exe")) {
    searchDir = extractNsis(source);
  } else {
    throw new Error(
      "Unsupported file type. Provide a MQDH .exe.zip, .exe, or extracted directory.",
    );
  }

  // Find the APK
  const apkPath = join(searchDir, NSIS_APK_REL);
  if (!existsSync(apkPath)) {
    // Try to find it anywhere in the extracted tree
    const found = findFile(searchDir, APK_FILENAME);
    if (!found) {
      throw new Error(
        `Could not find ${APK_FILENAME} in extracted MQDH. Is this the right installer?`,
      );
    }
    copyFileSync(found, CASTING_APK_PATH);
  } else {
    copyFileSync(apkPath, CASTING_APK_PATH);
  }

  // Cleanup temp extraction dirs
  rmSync(join(APK_DIR, "mqdh-app-tmp"), { recursive: true, force: true });

  return CASTING_APK_PATH;
}

function extractNsis(exePath: string): string {
  // Step 1: Extract NSIS installer
  const nsisDir = join(APK_DIR, "mqdh-nsis-tmp");
  rmSync(nsisDir, { recursive: true, force: true });
  execFileSync("7z", ["x", `-o${nsisDir}`, exePath, "-y"], { stdio: "pipe" });

  // Step 2: Extract app-64.7z inside $PLUGINSDIR
  const inner = join(nsisDir, "$PLUGINSDIR", "app-64.7z");
  if (!existsSync(inner)) {
    throw new Error("Could not find app-64.7z inside NSIS installer");
  }
  const appDir = join(APK_DIR, "mqdh-app-tmp");
  rmSync(appDir, { recursive: true, force: true });
  execFileSync("7z", ["x", `-o${appDir}`, inner, "-y"], { stdio: "pipe" });

  // Clean up NSIS dir (keep appDir)
  rmSync(nsisDir, { recursive: true, force: true });

  return appDir;
}

/** Recursively find a file by name */
function findFile(dir: string, name: string): string | null {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        const found = findFile(full, name);
        if (found) return found;
      } else if (entry === name) {
        return full;
      }
    } catch {
      // Skip permission errors
    }
  }
  return null;
}

/** Check whether the casting APK has been extracted locally */
export function hasCastingApk(): boolean {
  return existsSync(CASTING_APK_PATH);
}

/** Check if casting service is installed on the connected Quest device */
export async function isCastingInstalled(device: string): Promise<boolean> {
  try {
    const output = await execCommand("adb", [
      "-s", device, "shell", "pm", "list", "packages", CASTING_PKG,
    ]);
    return output.includes(CASTING_PKG);
  } catch {
    return false;
  }
}

/** Install the casting APK onto the Quest device */
export async function installCastingApk(device: string): Promise<void> {
  if (!hasCastingApk()) {
    throw new Error(
      `Casting APK not found. Run: quest-dev setup-cast <path-to-mqdh-installer>`,
    );
  }
  verbose(`Installing casting APK on ${device}...`);
  await execCommand("adb", ["-s", device, "install", "-r", CASTING_APK_PATH]);
}

/** Ensure casting service is installed, installing if needed. Returns true if install was performed. */
export async function ensureCastingInstalled(device: string): Promise<boolean> {
  if (await isCastingInstalled(device)) {
    verbose("Casting service already installed");
    return false;
  }
  if (!hasCastingApk()) {
    throw new Error(
      `Casting service not installed on Quest and APK not found locally.\n` +
      `Download Meta Quest Developer Hub from https://developer.oculus.com/meta-quest-developer-hub\n` +
      `Then run: quest-dev setup-cast <path-to-mqdh-installer.exe.zip>`,
    );
  }
  console.log("Installing casting service on Quest...");
  await installCastingApk(device);
  console.log("Casting service installed");
  return true;
}
