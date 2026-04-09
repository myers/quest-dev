/**
 * Config file loading for quest-dev
 * Resolves settings from CLI flags → ~/.config/quest-dev/config.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface QuestDevConfig {
  pin?: string;
  port?: number;
  device?: string;
  idleTimeout?: number;
  lowBattery?: number;
}

const CONFIG_PATH = join(homedir(), '.config', 'quest-dev', 'config.json');

/**
 * Load config from ~/.config/quest-dev/config.json
 */
export function loadConfig(): QuestDevConfig {
  try {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
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
  if (values.device !== undefined) merged.device = values.device;
  if (values.idleTimeout !== undefined) merged.idleTimeout = values.idleTimeout;
  if (values.lowBattery !== undefined) merged.lowBattery = values.lowBattery;

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
  return CONFIG_PATH;
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
