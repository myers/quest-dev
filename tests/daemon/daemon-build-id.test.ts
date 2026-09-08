import { describe, expect, it } from "vitest";
import { daemonBuildId } from "../../src/daemon/client.js";
import { getBuildId, getPackageVersion } from "../../src/utils/version.js";

/**
 * Bug: `deploy` runs inside the per-device daemon, but the CLI only restarted
 * that daemon on a *semver* mismatch. After a local `pnpm run build` at the
 * same version, the daemon kept serving the old code and the deploy you ran
 * was not the one you just built (iss quest-dev-daemon-stale-after-rebuild).
 *
 * Fix: compare build identities, not version strings.
 */
describe("daemon build identity", () => {
  it("stamps the version with a build marker", () => {
    expect(getBuildId().startsWith(getPackageVersion())).toBe(true);
    expect(getBuildId()).not.toBe(getPackageVersion());
  });

  it("prefers the daemon's reported build over its version", () => {
    expect(daemonBuildId({ version: "2.5.2", build: "2.5.2+stamp" })).toBe("2.5.2+stamp");
  });

  it("treats a build-less daemon as its bare version, which never matches a stamped CLI", () => {
    const old = daemonBuildId({ version: getPackageVersion() });
    expect(old).toBe(getPackageVersion());
    expect(old).not.toBe(getBuildId());
  });

  it("returns null when /status carries neither field", () => {
    expect(daemonBuildId({})).toBeNull();
  });
});
