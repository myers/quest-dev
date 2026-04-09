/**
 * Casting APK extraction and installation utilities.
 *
 * The casting service APK ships inside Meta Quest Developer Hub (MQDH).
 *
 * Supported MQDH sources:
 *   - macOS: /Applications/Meta Quest Developer Hub.app (or any .app bundle)
 *   - macOS: .dmg file (mounted, APKs extracted from the .app inside)
 *   - Windows: .exe.zip or .exe (NSIS installer, extracted via 7z)
 *   - Any platform: pre-extracted directory containing the APK files
 */

import { existsSync, mkdirSync, statSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execCommand } from "./exec.js";
import { verbose } from "./verbose.js";

const CASTING_PKG = "com.oculus.magicislandcastingservice";
const RELEASE_APK = "com.oculus.magicislandcastingservice.release.apk";
const APK_DIR = join(homedir(), ".local", "share", "quest-dev");
const RELEASE_APK_PATH = join(APK_DIR, RELEASE_APK);

/** APK location inside the macOS .app bundle */
const MACOS_APP_REL = "Contents/Resources/bin/Casting/Resources/";

/** APK location inside the Windows NSIS-extracted MQDH */
const WINDOWS_RES_REL = "resources/bin/Casting/Resources/";

/** Default macOS install location */
const MACOS_DEFAULT_APP = "/Applications/Meta Quest Developer Hub.app";

/**
 * Try to find MQDH on this machine without user input.
 * Returns the path if found, null otherwise.
 */
export function findInstalledMqdh(): string | null {
  if (platform() === "darwin") {
    if (existsSync(MACOS_DEFAULT_APP)) {
      return MACOS_DEFAULT_APP;
    }
    const userApps = join(homedir(), "Applications", "Meta Quest Developer Hub.app");
    if (existsSync(userApps)) {
      return userApps;
    }
  }
  return null;
}

/**
 * Extract the casting APK from a MQDH source.
 *
 * Accepts:
 *   - macOS .app bundle (e.g. /Applications/Meta Quest Developer Hub.app)
 *   - macOS .dmg disk image
 *   - Windows .exe.zip or .exe (requires 7z)
 *   - Any directory containing the APK file
 */
export async function extractCastingApk(source: string): Promise<string> {
  mkdirSync(APK_DIR, { recursive: true });

  const stat = statSync(source);
  let searchDir: string;

  if (stat.isDirectory() && source.endsWith(".app")) {
    searchDir = source;
    verbose(`Using macOS .app bundle: ${source}`);
  } else if (stat.isDirectory()) {
    searchDir = source;
  } else if (source.endsWith(".dmg")) {
    searchDir = await extractDmg(source);
  } else if (source.endsWith(".zip")) {
    require7z();
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
    require7z();
    searchDir = extractNsis(source);
  } else {
    throw new Error(
      `Unsupported file type: ${source}\n` +
      `Supported formats: .app (macOS), .dmg (macOS), .exe.zip (Windows), .exe (Windows), or a directory`,
    );
  }

  // Try known paths first, then fall back to recursive search
  if (!copyApk(searchDir, [MACOS_APP_REL, WINDOWS_RES_REL])) {
    throw new Error(
      "Could not find casting APK. Is this the right MQDH installation?",
    );
  }

  // Cleanup temp extraction dirs
  for (const tmp of ["mqdh-app-tmp", "mqdh-nsis-tmp", "mqdh-zip-tmp", "mqdh-dmg-tmp"]) {
    rmSync(join(APK_DIR, tmp), { recursive: true, force: true });
  }

  return APK_DIR;
}

/**
 * Copy the release APK from a search directory, trying known relative paths
 * first, then falling back to recursive search.
 */
function copyApk(searchDir: string, knownPaths: string[]): boolean {
  // Try known paths first
  for (const relPath of knownPaths) {
    const candidate = join(searchDir, relPath, RELEASE_APK);
    if (existsSync(candidate)) {
      copyFileSync(candidate, RELEASE_APK_PATH);
      return true;
    }
  }
  // Fall back to recursive search
  const found = findFile(searchDir, RELEASE_APK);
  if (found) {
    copyFileSync(found, RELEASE_APK_PATH);
    return true;
  }
  return false;
}

/** Mount a .dmg and extract APKs from the .app inside */
async function extractDmg(dmgPath: string): Promise<string> {
  if (platform() !== "darwin") {
    throw new Error(
      ".dmg files can only be opened on macOS. On other platforms, mount the DMG and point to the .app inside.",
    );
  }

  const mountPoint = join(APK_DIR, "mqdh-dmg-tmp");
  rmSync(mountPoint, { recursive: true, force: true });
  mkdirSync(mountPoint, { recursive: true });

  try {
    execFileSync("hdiutil", ["attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse", "-quiet"], {
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(`Failed to mount DMG: ${(e as Error).message}`);
  }

  try {
    const entries = readdirSync(mountPoint);
    const app = entries.find((e) => e.endsWith(".app"));
    if (!app) {
      throw new Error("No .app found inside DMG");
    }
    return join(mountPoint, app);
  } catch (e) {
    try { execFileSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "pipe" }); } catch {}
    throw e;
  }
}

function require7z(): void {
  try {
    execFileSync("7z", ["--help"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "7z is required to extract Windows MQDH installers.\n" +
      "Install it with: sudo apt install p7zip-full (Linux) or brew install p7zip (macOS)",
    );
  }
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

/** Check whether the casting APK has been extracted locally */
export function hasCastingApk(): boolean {
  return existsSync(RELEASE_APK_PATH);
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
 *
 * Uses the release APK which matches the system app's signing certificate.
 * This installs as UPDATED_SYSTEM_APP, preserving privileged permissions.
 */
export async function installCastingApk(device: string): Promise<void> {
  if (!hasCastingApk()) {
    throw new Error(
      `Casting APK not found. Run: quest-dev setup-cast`,
    );
  }

  try {
    await execCommand("adb", ["-s", device, "install", "-r", "-g", RELEASE_APK_PATH]);
  } catch (error) {
    throw new Error(
      `Failed to install casting APK: ${(error as Error).message}\n` +
      `Try installing manually: adb -s ${device} install -r -g ${RELEASE_APK_PATH}`,
    );
  }
}

/** Ensure casting service is installed, installing if needed. */
export async function ensureCastingInstalled(device: string): Promise<boolean> {
  if (await isCastingInstalled(device)) {
    verbose("Casting service already installed");
    return false;
  }

  // If we don't have the APK locally, try to find MQDH on this machine
  if (!hasCastingApk()) {
    const mqdh = findInstalledMqdh();
    if (mqdh) {
      console.log(`Found MQDH at ${mqdh}, extracting casting APK...`);
      await extractCastingApk(mqdh);
    } else {
      throw new Error(
        `Casting service not installed on Quest and APK not found locally.\n\n` +
        `To fix this, run:\n\n` +
        `  quest-dev setup-cast\n\n` +
        `This will guide you through downloading and extracting the casting APK.`,
      );
    }
  }
  console.log("Installing casting service on Quest...");
  await installCastingApk(device);
  console.log("Casting service installed");
  return true;
}
