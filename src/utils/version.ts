import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached: string | null = null;

export function getPackageVersion(): string {
  if (cached !== null) return cached;
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
  );
  cached = pkg.version as string;
  return cached;
}
