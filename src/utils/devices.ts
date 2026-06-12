/**
 * Alias registry: maps a human-friendly handle (e.g. "quest3") to a current
 * transport address and the device's stable hardware serial. Pure map ops
 * here; persistence lives in the I/O wrapper (loadDevices/saveDevices).
 */

export interface DeviceEntry {
  address: string; // how to reach it now (e.g. 127.0.0.1:5555)
  serial: string;  // stable hardware identity (ro.serialno)
}

export type DeviceMap = Record<string, DeviceEntry>;

/** Add or update an alias. The alias follows the physical device, so the
 * serial is overwritten with whatever the latest address reports. */
export function setAlias(
  map: DeviceMap,
  alias: string,
  address: string,
  serial: string,
): DeviceMap {
  return { ...map, [alias]: { address, serial } };
}

export function removeAlias(map: DeviceMap, alias: string): DeviceMap {
  if (!(alias in map)) return map;
  const next = { ...map };
  delete next[alias];
  return next;
}

/** Resolve a user ref to a reachable address. If the ref names a known alias,
 * use its stored address; otherwise treat the ref itself as a raw address. */
export function lookupRef(
  map: DeviceMap,
  ref: string,
): { address: string; alias: string | undefined } {
  const entry = map[ref];
  if (entry) return { address: entry.address, alias: ref };
  return { address: ref, alias: undefined };
}
