/**
 * Config file loading for quest-dev
 * Resolves settings from CLI flags → ~/.config/quest-dev/config.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { configDir } from './paths.js';

export interface QuestDevConfig {
  pin?: string;
  port?: number;
  host?: string;
  device?: string;
  idleTimeout?: number;
  lowBattery?: number;
  unpluggedTimeout?: number;
  debuggingPort?: number;
}

/**
 * Path to config.json, honoring XDG_CONFIG_HOME (via configDir) with a
 * ~/.config fallback. A function, not a const, so the env var is read at
 * call time — keeping config.json and devices.json in the same XDG root.
 */
export function configPath(): string {
  return join(configDir(), 'config.json');
}

/**
 * Load config from configDir()/config.json (XDG-aware).
 */
export function loadConfig(): QuestDevConfig {
  try {
    const content = readFileSync(configPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Save config values to ~/.config/quest-dev/config.json
 * Merges with existing config (doesn't overwrite unrelated fields).
 */
export function saveConfig(values: QuestDevConfig): string {
  const existing = loadConfig();

  const merged = { ...existing };
  if (values.pin !== undefined) merged.pin = values.pin;
  if (values.port !== undefined) merged.port = values.port;
  if (values.host !== undefined) merged.host = values.host;
  if (values.device !== undefined) merged.device = values.device;
  if (values.idleTimeout !== undefined) merged.idleTimeout = values.idleTimeout;
  if (values.lowBattery !== undefined) merged.lowBattery = values.lowBattery;
  if (values.unpluggedTimeout !== undefined) merged.unpluggedTimeout = values.unpluggedTimeout;
  if (values.debuggingPort !== undefined) merged.debuggingPort = values.debuggingPort;

  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n');
  return path;
}

/**
 * Resolve PIN from CLI flag, then config files
 */
export function loadPin(cliPin?: string): string {
  if (cliPin) return cliPin;

  const config = loadConfig();
  if (config.pin) return config.pin;

  console.error('Error: No PIN found');
  console.error('');
  console.error('Provide a PIN via one of:');
  console.error('  --pin <pin>                           CLI flag');
  console.error('  quest-dev config --pin <pin>          Save as default');
  console.error('');
  console.error('The PIN is your Meta Store PIN for the logged-in account.');
  process.exit(1);
}

/**
 * Like loadPin, but returns null instead of exiting when no PIN is configured.
 * Use this in long-running processes (e.g. the daemon) where a missing PIN
 * should fail one request, not crash the whole process.
 */
export function tryLoadPin(cliPin?: string): string | null {
  if (cliPin) return cliPin;
  const config = loadConfig();
  if (config.pin) return config.pin;
  return null;
}
