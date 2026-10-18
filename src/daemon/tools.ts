/**
 * Host tools the daemon shells out to. The daemon inherits the PATH of
 * whichever command auto-started it and keeps it for its whole life, so a
 * daemon started from a shell without build-tools later fails every deploy
 * ("Cannot extract package name"). Check before spawning instead.
 */

import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

function onPath(tool: string, path: string): boolean {
  return path.split(delimiter).some((dir) => dir && existsSync(join(dir, tool)));
}

/** Newest `<sdk>/build-tools/<ver>` holding aapt2, or null. */
function sdkBuildTools(sdk: string): string | null {
  const root = join(sdk, "build-tools");
  let versions: string[];
  try {
    versions = readdirSync(root);
  } catch {
    return null;
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    if (existsSync(join(root, v, "aapt2"))) return join(root, v);
  }
  return null;
}

/**
 * PATH the daemon must run with: the caller's PATH, plus the Android SDK's
 * newest build-tools dir when aapt2 is only found there. Throws when adb or
 * aapt2 can't be found, so a daemon never starts without them.
 */
export function daemonPath(env: NodeJS.ProcessEnv = process.env): string {
  let path = env.PATH ?? "";
  const missing: string[] = [];
  if (!onPath("adb", path)) missing.push("adb");
  if (!onPath("aapt2", path)) {
    const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
    const bt = sdk ? sdkBuildTools(sdk) : null;
    if (bt) path = `${bt}${delimiter}${path}`;
    else missing.push("aapt2");
  }
  if (missing.length) {
    throw new Error(
      `Refusing to start the quest-dev daemon: ${missing.join(" and ")} not found. ` +
        `The daemon keeps this PATH for its whole life, so deploy would fail later. ` +
        `Put Android platform-tools and build-tools/<ver> on PATH, or set ANDROID_HOME to the SDK.`,
    );
  }
  return path;
}
