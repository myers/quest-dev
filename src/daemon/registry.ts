/**
 * Per-serial daemon registry. Each running daemon owns one JSON file keyed by
 * its device's hardware serial, replacing the former single daemon.json.
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { runtimeDir, sanitizeSerial } from '../utils/paths.js';

export interface DaemonRecord {
  pid: number;
  port: number;       // actual OS-assigned HTTP port
  serial: string;     // stable identity (key)
  address: string;    // current transport address
  cdpPort: number;    // actual forwarded CDP port
  castPort: number;   // actual cast listen port
  startedAt: string;  // ISO timestamp (stamped by caller)
}

function daemonsDir(): string {
  return join(runtimeDir(), 'daemons');
}

export function registryPath(serial: string): string {
  return join(daemonsDir(), `${sanitizeSerial(serial)}.json`);
}

export function writeRegistry(rec: DaemonRecord): void {
  mkdirSync(daemonsDir(), { recursive: true });
  writeFileSync(registryPath(rec.serial), JSON.stringify(rec, null, 2) + '\n');
}

export function readRegistry(serial: string): DaemonRecord | null {
  try {
    return JSON.parse(readFileSync(registryPath(serial), 'utf-8')) as DaemonRecord;
  } catch {
    return null;
  }
}

export function removeRegistry(serial: string): void {
  try { unlinkSync(registryPath(serial)); } catch { /* already gone */ }
}
