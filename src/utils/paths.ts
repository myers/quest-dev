/**
 * XDG Base Directory resolver for quest-dev.
 * Single source of truth for runtime/state/config/data paths so no other
 * module hardcodes $HOME-relative locations.
 */
import { join } from 'path';
import { homedir } from 'os';

const APP = 'quest-dev';

function xdg(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return join(v && v.length > 0 ? v : fallback, APP);
}

/** Runtime files: daemon registry, PID files, sockets. Session-scoped. */
export function runtimeDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && runtime.length > 0) return join(runtime, APP);
  // No runtime dir (common on macOS): persist under state home instead.
  return join(stateDir(), 'run');
}

/** Persistent state: logs. Survives restarts. */
export function stateDir(): string {
  return xdg('XDG_STATE_HOME', join(homedir(), '.local', 'state'));
}

/** User config: config.json, devices.json. */
export function configDir(): string {
  return xdg('XDG_CONFIG_HOME', join(homedir(), '.config'));
}

/** Device-agnostic data: casting APK. */
export function dataDir(): string {
  return xdg('XDG_DATA_HOME', join(homedir(), '.local', 'share'));
}

/** Make a serial safe for use as a filename. */
export function sanitizeSerial(serial: string): string {
  return serial.replace(/[^A-Za-z0-9_-]/g, '_');
}
