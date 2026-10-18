import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonPath } from "../../src/daemon/tools.js";

function bin(dir: string, ...tools: string[]): string {
  mkdirSync(dir, { recursive: true });
  for (const t of tools) writeFileSync(join(dir, t), "");
  return dir;
}

describe("daemonPath", () => {
  const root = mkdtempSync(join(tmpdir(), "qd-tools-"));
  const pt = bin(join(root, "platform-tools"), "adb");

  it("keeps PATH when adb and aapt2 are on it", () => {
    const bt = bin(join(root, "bt"), "aapt2");
    expect(daemonPath({ PATH: `${pt}:${bt}` })).toBe(`${pt}:${bt}`);
  });

  it("prepends the SDK's newest build-tools holding aapt2", () => {
    const sdk = join(root, "sdk");
    bin(join(sdk, "build-tools", "9.0.0"), "aapt2");
    bin(join(sdk, "build-tools", "34.0.0"), "aapt2");
    bin(join(sdk, "build-tools", "35.0.0")); // no aapt2
    expect(daemonPath({ PATH: pt, ANDROID_HOME: sdk })).toBe(`${join(sdk, "build-tools", "34.0.0")}:${pt}`);
  });

  it("refuses when aapt2 is nowhere", () => {
    expect(() => daemonPath({ PATH: pt })).toThrow(/aapt2 not found/);
  });

  it("refuses when adb is missing", () => {
    expect(() => daemonPath({ PATH: bin(join(root, "only-aapt"), "aapt2") })).toThrow(/adb not found/);
  });
});
