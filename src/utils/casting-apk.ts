/**
 * Casting APK extraction and installation utilities.
 *
 * The casting service APK ships inside Meta Quest Developer Hub (MQDH).
 * We extract both debug and release variants:
 *   - Release APK: needed for Quest 2 (system app has matching signature)
 *   - Debug APK: needed for Quest 3/3S (no system app pre-installed)
 *
 * On install, we try release first (works if system app exists or no conflict),
 * then fall back to debug if release fails (signature mismatch = no system app).
 */

import { existsSync, mkdirSync, statSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { execCommand } from "./exec.js";
import { verbose } from "./verbose.js";

const CASTING_PKG = "com.oculus.magicislandcastingservice";
const RELEASE_APK = "com.oculus.magicislandcastingservice.release.apk";
const DEBUG_APK = "com.oculus.magicislandcastingservice.debug.apk";
const APK_DIR = join(homedir(), ".local", "share", "quest-dev");
const RELEASE_APK_PATH = join(APK_DIR, RELEASE_APK);
const DEBUG_APK_PATH = join(APK_DIR, DEBUG_APK);

/** Path inside the NSIS-extracted MQDH where the APKs live */
const CASTING_RES_REL = "resources/bin/Casting/Resources/";

/**
 * Extract casting APKs from a MQDH installer (.exe.zip, .exe, or pre-extracted dir).
 * Extracts both release and debug variants.
 */
export async function extractCastingApk(source: string): Promise<string> {
  mkdirSync(APK_DIR, { recursive: true });

  const stat = statSync(source);
  let searchDir: string;

  if (stat.isDirectory()) {
    searchDir = source;
  } else if (source.endsWith(".zip")) {
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

  // Extract both APK variants
  let found = 0;
  for (const [filename, destPath] of [
    [RELEASE_APK, RELEASE_APK_PATH],
    [DEBUG_APK, DEBUG_APK_PATH],
  ] as const) {
    const knownPath = join(searchDir, CASTING_RES_REL, filename);
    if (existsSync(knownPath)) {
      copyFileSync(knownPath, destPath);
      found++;
    } else {
      const foundPath = findFile(searchDir, filename);
      if (foundPath) {
        copyFileSync(foundPath, destPath);
        found++;
      }
    }
  }

  if (found === 0) {
    throw new Error(
      "Could not find casting APKs in extracted MQDH. Is this the right installer?",
    );
  }

  // Cleanup temp extraction dirs
  rmSync(join(APK_DIR, "mqdh-app-tmp"), { recursive: true, force: true });

  const variants = [
    existsSync(RELEASE_APK_PATH) ? "release" : null,
    existsSync(DEBUG_APK_PATH) ? "debug" : null,
  ].filter(Boolean);
  console.log(`Extracted casting APKs (${variants.join(", ")})`);

  return APK_DIR;
}

function extractNsis(exePath: string): string {
  const nsisDir = join(APK_DIR, "mqdh-nsis-tmp");
  rmSync(nsisDir, { recursive: true, force: true });
  execFileSync("7z", ["x", `-o${nsisDir}`, exePath, "-y"], { stdio: "pipe" });

  const inner = join(nsisDir, "$PLUGINSDIR", "app-64.7z");
  if (!existsSync(inner)) {
    throw new Error("Could not find app-64.7z inside NSIS installer");
  }
  const appDir = join(APK_DIR, "mqdh-app-tmp");
  rmSync(appDir, { recursive: true, force: true });
  execFileSync("7z", ["x", `-o${appDir}`, inner, "-y"], { stdio: "pipe" });

  rmSync(nsisDir, { recursive: true, force: true });
  return appDir;
}

/** Recursively find a file by name */
function findFile(dir: string, name: string): string | null {
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

/** Check whether any casting APK variant has been extracted locally */
export function hasCastingApk(): boolean {
  return existsSync(RELEASE_APK_PATH) || existsSync(DEBUG_APK_PATH);
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

/**
 * Install the casting APK onto the Quest device.
 * Tries release APK first (works on Quest 2 with system app),
 * falls back to debug APK (works on Quest 3/3S without system app).
 */
export async function installCastingApk(device: string): Promise<void> {
  if (!hasCastingApk()) {
    throw new Error(
      `Casting APK not found. Run: quest-dev setup-cast <path-to-mqdh-installer>`,
    );
  }

  // On Quest 2, the casting service is a system app. The system version's
  // signature only matches the release APK. On Quest 3, there's no system
  // version, so either APK works — but we must uninstall for user 0 first
  // if the system version was previously disabled.
  //
  // Strategy: try release first, fall back to debug.
  const apksToTry: [string, string][] = [];
  if (existsSync(RELEASE_APK_PATH)) {
    apksToTry.push(["release", RELEASE_APK_PATH]);
  }
  if (existsSync(DEBUG_APK_PATH)) {
    apksToTry.push(["debug", DEBUG_APK_PATH]);
  }

  for (const [variant, path] of apksToTry) {
    try {
      verbose(`Trying ${variant} APK: ${path}`);
      await execCommand("adb", ["-s", device, "install", "-r", "-g", path]);
      verbose(`Installed ${variant} casting APK`);
      return;
    } catch (error) {
      verbose(`${variant} APK install failed: ${(error as Error).message}`);
      // If signature mismatch and this is a system app, try uninstalling
      // for the current user first to clear the system version
      if ((error as Error).message.includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE")) {
        try {
          verbose("Uninstalling system version for current user...");
          await execCommand("adb", [
            "-s", device, "shell", "pm", "uninstall", "-k", "--user", "0", CASTING_PKG,
          ]);
          // Retry this variant
          try {
            await execCommand("adb", ["-s", device, "install", "-r", "-g", path]);
            verbose(`Installed ${variant} casting APK (after user uninstall)`);
            return;
          } catch {
            verbose(`${variant} APK still failed after user uninstall`);
          }
        } catch {
          verbose("User uninstall failed");
        }
      }
    }
  }

  throw new Error(
    "Failed to install casting APK. Try installing manually:\n" +
    `  adb -s ${device} install -r ${RELEASE_APK_PATH}`,
  );
}

/** Ensure casting service is installed, installing if needed. */
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
