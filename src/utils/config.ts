/**
 * Config file loading for quest-dev
 * Resolves settings from CLI flags → .quest-dev.json → ~/.config/quest-dev/config.json
 */

import { readFileSync } from 'fs';
import { join } from 'path';
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
  console.error('  .quest-dev.json                       { "pin": "1234" }');
  console.error('  ~/.config/quest-dev/config.json       { "pin": "1234" }');
  console.error('');
  console.error('The PIN is your Meta Store PIN for the logged-in account.');
  process.exit(1);
}
