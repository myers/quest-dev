import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached: string | null = null;
let cachedBuildId: string | null = null;

export function getPackageVersion(): string {
  if (cached !== null) return cached;
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
  );
  cached = pkg.version as string;
  return cached;
}

/**
 * Identity of the *build* this process is running, not just its semver.
 *
 * `pnpm run build` does `rm -rf build && tsc`, so every rebuild gives this
 * module file a new mtime even when package.json's version is unchanged. The
 * daemon reports its build id on /status and the CLI compares it against its
 * own: a daemon still serving pre-rebuild code is then visible, instead of
 * silently running the old `deploy` because the semver strings matched.
 *
 * ponytail: mtime, not a content hash — a hash means hashing the whole build
 * dir on every command for a stamp that already changes on every build.
 */
export function getBuildId(): string {
  if (cachedBuildId !== null) return cachedBuildId;
  let stamp: string;
  try {
    stamp = new Date(statSync(fileURLToPath(import.meta.url)).mtimeMs).toISOString();
  } catch {
    // Unstattable (bundled/virtual fs): degrade to version-only, which both
    // sides compute identically, so no spurious restart loop.
    cachedBuildId = getPackageVersion();
    return cachedBuildId;
  }
  cachedBuildId = `${getPackageVersion()}+${stamp}`;
  return cachedBuildId;
}
