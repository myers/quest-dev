/**
 * Config file loading for quest-dev
 * Resolves settings from CLI flags → .quest-dev.json → ~/.config/quest-dev/config.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface QuestDevConfig {
  pin?: string;
  idleTimeout?: number;
  lowBattery?: number;
}

const CONFIG_LOCATIONS = [
  join(process.cwd(), '.quest-dev.json'),
  join(homedir(), '.config', 'quest-dev', 'config.json'),
];

function tryReadConfig(path: string): QuestDevConfig | null {
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Load merged config from all config file locations.
 * First file found wins for each field.
 */
export function loadConfig(): QuestDevConfig {
  const merged: QuestDevConfig = {};

  for (const path of CONFIG_LOCATIONS) {
    const config = tryReadConfig(path);
    if (!config) continue;
    if (merged.pin === undefined && config.pin) merged.pin = config.pin;
    if (merged.idleTimeout === undefined && config.idleTimeout !== undefined) merged.idleTimeout = config.idleTimeout;
    if (merged.lowBattery === undefined && config.lowBattery !== undefined) merged.lowBattery = config.lowBattery;
  }

  return merged;
}

/**
 * Save config values to ~/.config/quest-dev/config.json
 * Merges with existing config (doesn't overwrite unrelated fields).
 */
export function saveConfig(values: QuestDevConfig): string {
  const configPath = join(homedir(), '.config', 'quest-dev', 'config.json');
  let existing: QuestDevConfig = {};
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // No existing config, start fresh
  }

  const merged = { ...existing };
  if (values.pin !== undefined) merged.pin = values.pin;
  if (values.idleTimeout !== undefined) merged.idleTimeout = values.idleTimeout;
  if (values.lowBattery !== undefined) merged.lowBattery = values.lowBattery;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  return configPath;
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
