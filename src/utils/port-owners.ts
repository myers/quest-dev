/**
 * Identify the Android processes holding a given TCP port LISTEN socket.
 *
 * Used at deploy time to detect the orphan-app scenario: a previously-
 * launched app is still bound to its debugging/RPC port (e.g. Bevy BRP
 * 15702, React Native Metro 8081, Flutter DDS), so the freshly-deployed
 * app silently fails to rebind and clients end up talking to (and
 * waiting on) the previous instance.
 */

export interface PortListener {
  uid: number;
  inode: number;
}

/**
 * Parse one or more concatenated `/proc/net/tcp` / `/proc/net/tcp6` dumps
 * and return all LISTEN sockets (state code `0A`) bound to `port`.
 *
 * IPv4 and IPv6 lines look like:
 *   sl  local_address rem_address st ... uid timeout inode ...
 *
 * - `local_address` is `<addr-hex>:<port-hex>` (port hex is 4 chars in tcp4
 *   and tcp6; address width differs but we only care about the port).
 * - `st` is the connection state; `0A` is LISTEN.
 */
export function parsePortListenersFromProcNet(
  procNet: string,
  port: number,
): PortListener[] {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const out: PortListener[] = [];
  for (const line of procNet.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // Min cols: sl local rem st txq rxq tr tm retr uid to inode ...
    if (cols.length < 12) continue;
    const local = cols[1];
    if (!local || !local.includes(':')) continue;
    const linePort = local.slice(local.lastIndexOf(':') + 1).toUpperCase();
    if (linePort !== portHex) continue;
    if (cols[3] !== '0A') continue;
    const uid = parseInt(cols[7], 10);
    const inode = parseInt(cols[9], 10);
    if (Number.isNaN(uid) || Number.isNaN(inode)) continue;
    out.push({ uid, inode });
  }
  return out;
}

/**
 * Parse the output of `adb shell pm list packages -U` into a uid → package
 * map. Lines look like `package:net.monoloco.keyboarddemo uid:10186`.
 */
export function parsePmListPackagesU(output: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /^package:(\S+)\s+uid:(\d+)\s*$/;
  for (const line of output.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const uid = parseInt(m[2], 10);
    if (Number.isNaN(uid)) continue;
    map.set(uid, m[1]);
  }
  return map;
}

/**
 * A function that runs `adb [args...]` on the connected device and returns
 * stdout. Indirected through this interface so the port-owner logic can be
 * unit-tested without spawning real adb processes.
 */
export type AdbCommandRunner = (args: string[]) => Promise<string>;

export interface PortOwner extends PortListener {
  /** Package name owning the uid, or null if the snapshot didn't capture it. */
  packageName: string | null;
}

/**
 * Identify every Android package currently holding a LISTEN socket on
 * `port`. Reads both `/proc/net/tcp` and `/proc/net/tcp6` (LISTEN sockets
 * appear in whichever family the app bound) and joins against
 * `pm list packages -U`.
 */
export async function findPortOwners(
  port: number,
  adb: AdbCommandRunner,
): Promise<PortOwner[]> {
  const [tcp4, tcp6, pmList] = await Promise.all([
    adb(['shell', 'cat', '/proc/net/tcp']),
    adb(['shell', 'cat', '/proc/net/tcp6']),
    adb(['shell', 'pm', 'list', 'packages', '-U']),
  ]);
  const listeners = parsePortListenersFromProcNet(`${tcp4}\n${tcp6}`, port);
  const uidToPkg = parsePmListPackagesU(pmList);
  return listeners.map((l) => ({
    ...l,
    packageName: uidToPkg.get(l.uid) ?? null,
  }));
}

export interface PortConflictReport {
  /** Owners we force-stopped. */
  stopped: Array<{ packageName: string; uid: number }>;
  /** Owners we couldn't act on (no known package for the uid). */
  skipped: Array<{ uid: number; packageName: string | null }>;
}

/**
 * If any process other than `targetPackage` is holding `port`, force-stop
 * it so the deploy target can bind cleanly. The deploy target itself is
 * left alone because the existing install step will re-launch it.
 */
export async function resolvePortConflicts(options: {
  port: number;
  targetPackage: string;
  adb: AdbCommandRunner;
}): Promise<PortConflictReport> {
  const { port, targetPackage, adb } = options;
  const owners = await findPortOwners(port, adb);
  const stopped: PortConflictReport['stopped'] = [];
  const skipped: PortConflictReport['skipped'] = [];
  for (const owner of owners) {
    if (owner.packageName === targetPackage) continue;
    if (owner.packageName === null) {
      skipped.push({ uid: owner.uid, packageName: null });
      continue;
    }
    await adb(['shell', 'am', 'force-stop', owner.packageName]);
    stopped.push({ packageName: owner.packageName, uid: owner.uid });
  }
  return { stopped, skipped };
}
