/**
 * `quest-dev device` — manage the alias registry and introspect device ports.
 */
import { resolveDevice, type ResolvedDevice } from '../daemon/resolve.js';
import { readRegistry, type DaemonRecord } from '../daemon/registry.js';
import { loadDevices, saveDevices, setAlias, removeAlias } from '../utils/devices.js';
import { readSerial, getBatteryInfo, formatBatteryInfo, setAdbDevice, type BatteryInfo } from '../utils/adb.js';
import { execCommand } from '../utils/exec.js';

export interface DeviceInfo {
  alias: string | undefined;
  serial: string;
  address: string;
  daemonPort: number | null;
  cdpPort: number | null;
  castPort: number | null;
  stayAwake: boolean;
  battery: string | null;
}

/** Pure: assemble a DeviceInfo from resolved identity + optional daemon record
 * + optional battery. A live daemon record implies stay-awake is on. */
export function buildDeviceInfo(
  resolved: ResolvedDevice,
  record: DaemonRecord | null,
  battery: BatteryInfo | null,
): DeviceInfo {
  return {
    alias: resolved.alias,
    serial: resolved.serial,
    address: resolved.address,
    daemonPort: record?.port ?? null,
    cdpPort: record?.cdpPort ?? null,
    castPort: record?.castPort ?? null,
    stayAwake: record !== null,
    battery: battery ? formatBatteryInfo(battery) : null,
  };
}

export async function deviceSet(alias: string, address: string): Promise<void> {
  try { await execCommand('adb', ['connect', address]); } catch { /* USB serial path */ }
  const serial = await readSerial(address);
  saveDevices(setAlias(loadDevices(), alias, address, serial));
  console.log(`Saved alias '${alias}' → ${address} (serial ${serial})`);
}

export function deviceRm(alias: string): void {
  saveDevices(removeAlias(loadDevices(), alias));
  console.log(`Removed alias '${alias}'`);
}

export async function deviceList(json: boolean): Promise<void> {
  const map = loadDevices();
  const rows = Object.entries(map).map(([alias, e]) => ({
    alias, address: e.address, serial: e.serial, daemon: readRegistry(e.serial) ? 'running' : 'stopped',
  }));
  if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (rows.length === 0) { console.log('No aliases. Add one with: quest-dev device set <alias> <address>'); return; }
  for (const r of rows) console.log(`${r.alias}\t${r.address}\t${r.serial}\t${r.daemon}`);
}

export async function deviceInfo(ref: string | undefined, json: boolean): Promise<void> {
  const resolved = await resolveDevice(ref);
  const record = readRegistry(resolved.serial);
  let battery: BatteryInfo | null = null;
  try {
    setAdbDevice(resolved.address);
    battery = await getBatteryInfo();
  } catch { /* device may be unreachable */ }
  const info = buildDeviceInfo(resolved, record, battery);
  if (json) { console.log(JSON.stringify(info, null, 2)); return; }
  console.log(`alias:      ${info.alias ?? '(none)'}`);
  console.log(`serial:     ${info.serial}`);
  console.log(`address:    ${info.address}`);
  console.log(`daemonPort: ${info.daemonPort ?? '(not running)'}`);
  console.log(`cdpPort:    ${info.cdpPort ?? '(not running)'}`);
  console.log(`castPort:   ${info.castPort ?? '(not running)'}`);
  console.log(`stayAwake:  ${info.stayAwake}`);
  console.log(`battery:    ${info.battery ?? '(unknown)'}`);
}
