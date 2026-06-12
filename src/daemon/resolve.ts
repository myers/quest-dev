/**
 * Resolve a user-facing device reference into a concrete (address, serial)
 * pair. `selectRef` is the pure precedence rule; `resolveDevice` performs the
 * alias lookup, adb connect, and serial read.
 */
import { execCommand } from '../utils/exec.js';
import { readSerial } from '../utils/adb.js';
import { loadDevices, lookupRef } from '../utils/devices.js';
import { loadConfig } from '../utils/config.js';

/** Pure: pick which ref to use, given the precedence inputs. Throws if a ref
 * cannot be determined. `connected` is the list of currently-attached
 * device addresses (from `adb devices`). */
export function selectRef(
  cliDevice: string | undefined,
  envDevice: string | undefined,
  configDevice: string | undefined,
  connected: string[],
): string {
  if (cliDevice) return cliDevice;
  if (envDevice) return envDevice;
  if (configDevice) return configDevice;
  if (connected.length === 1) return connected[0];
  throw new Error(
    connected.length === 0
      ? 'No device specified and none connected. Use --device <alias|address>.'
      : `No device specified and multiple connected (${connected.join(', ')}). Use --device <alias|address>.`,
  );
}

/** Parse `adb devices` output into a list of attached device addresses. */
export async function listConnected(): Promise<string[]> {
  const out = await execCommand('adb', ['devices']);
  return out
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && l.endsWith('device'))
    .map((l) => l.split(/\s+/)[0]);
}

export interface ResolvedDevice {
  address: string;
  serial: string;
  alias: string | undefined;
}

/** Full resolution: ref selection → alias lookup → connect → serial read. */
export async function resolveDevice(cliDevice?: string): Promise<ResolvedDevice> {
  const connected = await listConnected();
  const ref = selectRef(
    cliDevice,
    process.env.QUEST_DEVICE,
    loadConfig().device,
    connected,
  );
  const { address, alias } = lookupRef(loadDevices(), ref);
  // adb connect TCP addresses (host:port) that aren't already attached.
  if (address.includes(':') && !connected.includes(address)) {
    try { await execCommand('adb', ['connect', address]); } catch { /* fall through to serial read */ }
  }
  const serial = await readSerial(address);
  return { address, serial, alias };
}
