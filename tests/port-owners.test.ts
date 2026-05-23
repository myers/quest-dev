import { describe, it, expect, vi } from 'vitest';
import {
  parsePortListenersFromProcNet,
  parsePmListPackagesU,
  findPortOwners,
  resolvePortConflicts,
  type AdbCommandRunner,
  type PortConflictReport,
} from '../src/utils/port-owners.js';

describe('parsePortListenersFromProcNet', () => {
  it('returns the uid of a LISTEN entry on the given port', () => {
    // Real /proc/net/tcp line from Quest 2 with port 15702 (0x3D56) LISTEN
    // owned by uid 10186.
    const procNet = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10186        0 1990850 1 0000000000000000 99 0 0 10 0',
      '',
    ].join('\n');

    const owners = parsePortListenersFromProcNet(procNet, 15702);

    expect(owners).toEqual([{ uid: 10186, inode: 1990850 }]);
  });

  it('skips non-LISTEN entries on the matching port (TIME_WAIT, ESTABLISHED)', () => {
    // st=06 is TIME_WAIT, not LISTEN (0A).
    const procNet = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   1: 982AA8C0:3D56 592AA8C0:ADD8 06 00000000:00000000 03:00000861 00000000     0        0 0 3 0000000000000000',
      '',
    ].join('\n');

    expect(parsePortListenersFromProcNet(procNet, 15702)).toEqual([]);
  });

  it('returns empty when no entry matches the requested port', () => {
    const procNet = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10186        0 1990850 1 0000000000000000 99 0 0 10 0',
    ].join('\n');

    expect(parsePortListenersFromProcNet(procNet, 9999)).toEqual([]);
  });

  it('returns multiple owners when several listeners exist on the same port (different uids on tcp4 + tcp6)', () => {
    // Concatenated /proc/net/tcp + /proc/net/tcp6 — the function should treat
    // them as a single stream and return both LISTEN entries.
    const procNet = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10183        0 1955097 1 0000000000000000 99 0 0 10 0',
      '   1: 00000000000000000000000000000000:3D56 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10186        0 1990850 1 0000000000000000 99 0 0 10 0',
    ].join('\n');

    const owners = parsePortListenersFromProcNet(procNet, 15702);
    expect(owners).toHaveLength(2);
    expect(owners).toContainEqual({ uid: 10183, inode: 1955097 });
    expect(owners).toContainEqual({ uid: 10186, inode: 1990850 });
  });
});

describe('parsePmListPackagesU', () => {
  it('maps uid to package name from `pm list packages -U` output', () => {
    const output = [
      'package:net.monoloco.keyboarddemo uid:10186',
      'package:com.bevychromium uid:10183',
      'package:net.monoloco.horizonwindowdemo uid:10187',
      '',
    ].join('\n');

    const map = parsePmListPackagesU(output);

    expect(map.get(10186)).toBe('net.monoloco.keyboarddemo');
    expect(map.get(10183)).toBe('com.bevychromium');
    expect(map.get(10187)).toBe('net.monoloco.horizonwindowdemo');
  });

  it('returns an empty map for empty input', () => {
    expect(parsePmListPackagesU('').size).toBe(0);
  });

  it('ignores lines that do not match the `package:NAME uid:N` shape', () => {
    const output = [
      'package:net.monoloco.keyboarddemo uid:10186',
      'this line is garbage',
      'package:invalid_no_uid',
      'package:com.bevychromium uid:10183',
    ].join('\n');

    const map = parsePmListPackagesU(output);
    expect(map.size).toBe(2);
    expect(map.get(10186)).toBe('net.monoloco.keyboarddemo');
    expect(map.get(10183)).toBe('com.bevychromium');
  });
});

describe('findPortOwners', () => {
  it('combines /proc/net/tcp + tcp6 dumps and uid->package map into named owners', async () => {
    const procTcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10183        0 1955097 1 0000000000000000 99 0 0 10 0',
    ].join('\n');
    const procTcp6 = '  sl  local_address rem_address   st ...\n';
    const pmList = 'package:com.bevychromium uid:10183\n';

    const runner: AdbCommandRunner = vi.fn(async (args: string[]) => {
      // Match by the leaf command name: cat <path> or pm list ...
      if (args.includes('cat') && args.includes('/proc/net/tcp')) {
        return procTcp;
      }
      if (args.includes('cat') && args.includes('/proc/net/tcp6')) {
        return procTcp6;
      }
      if (args.includes('pm') && args.includes('list') && args.includes('packages')) {
        return pmList;
      }
      throw new Error(`unexpected adb args: ${args.join(' ')}`);
    });

    const owners = await findPortOwners(15702, runner);

    expect(owners).toEqual([
      { uid: 10183, inode: 1955097, packageName: 'com.bevychromium' },
    ]);
  });

  it('returns an empty array when nothing is listening on the port', async () => {
    const empty = '  sl  local_address rem_address   st ...\n';
    const runner: AdbCommandRunner = vi.fn(async () => empty);

    const owners = await findPortOwners(15702, runner);

    expect(owners).toEqual([]);
  });

  it('reports owners whose uid is not in the pm-list map with packageName=null', async () => {
    // Unusual but possible: a system process or fresh-installed package not
    // captured by the snapshot. We surface it as null rather than dropping it,
    // so the caller can still log "uid 99999 holds port 15702".
    const procTcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 99999        0 7777 1 0000000000000000 99 0 0 10 0',
    ].join('\n');
    const runner: AdbCommandRunner = vi.fn(async (args: string[]) => {
      if (args.includes('cat') && args.includes('/proc/net/tcp')) return procTcp;
      return ''; // tcp6 empty, pm list empty
    });

    const owners = await findPortOwners(15702, runner);
    expect(owners).toEqual([
      { uid: 99999, inode: 7777, packageName: null },
    ]);
  });
});

describe('resolvePortConflicts', () => {
  function makeRunner(opts: {
    tcp4?: string;
    tcp6?: string;
    pmList?: string;
    onForceStop?: (pkg: string) => void;
  }): AdbCommandRunner {
    return async (args: string[]) => {
      if (args.includes('cat') && args.includes('/proc/net/tcp')) {
        return opts.tcp4 ?? '';
      }
      if (args.includes('cat') && args.includes('/proc/net/tcp6')) {
        return opts.tcp6 ?? '';
      }
      if (args.includes('pm') && args.includes('list') && args.includes('packages')) {
        return opts.pmList ?? '';
      }
      if (args.includes('am') && args.includes('force-stop')) {
        const pkg = args[args.indexOf('force-stop') + 1];
        opts.onForceStop?.(pkg);
        return '';
      }
      throw new Error(`unexpected adb args: ${args.join(' ')}`);
    };
  }

  it('force-stops an orphan Bevy app that owns the port and reports it', async () => {
    const stopped: string[] = [];
    const runner = makeRunner({
      tcp4:
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
        '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10183        0 1955097 1 0000000000000000 99 0 0 10 0',
      pmList: 'package:com.bevychromium uid:10183',
      onForceStop: (pkg) => stopped.push(pkg),
    });

    const report = await resolvePortConflicts({
      port: 15702,
      targetPackage: 'net.monoloco.keyboarddemo',
      adb: runner,
    });

    expect(stopped).toEqual(['com.bevychromium']);
    expect(report.stopped).toEqual([
      { packageName: 'com.bevychromium', uid: 10183 },
    ]);
    expect(report.skipped).toEqual([]);
  });

  it('does not force-stop the deploy target itself when it already owns the port', async () => {
    // Re-deploying the same app: it owns the port from the previous run, and
    // the install step will force-stop it anyway. Don't double-stop.
    const stopped: string[] = [];
    const runner = makeRunner({
      tcp4:
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
        '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10186        0 1990850 1 0000000000000000 99 0 0 10 0',
      pmList: 'package:net.monoloco.keyboarddemo uid:10186',
      onForceStop: (pkg) => stopped.push(pkg),
    });

    const report = await resolvePortConflicts({
      port: 15702,
      targetPackage: 'net.monoloco.keyboarddemo',
      adb: runner,
    });

    expect(stopped).toEqual([]);
    expect(report.stopped).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it('skips owners with no known package (cannot force-stop safely)', async () => {
    // An unknown uid can't be addressed via `am force-stop <pkg>`. We report
    // it as skipped so the operator knows something has the port but we
    // couldn't act on it.
    const stopped: string[] = [];
    const runner = makeRunner({
      tcp4:
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
        '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 99999        0 7777 1 0000000000000000 99 0 0 10 0',
      // pmList omitted — uid 99999 maps to nothing
      onForceStop: (pkg) => stopped.push(pkg),
    });

    const report: PortConflictReport = await resolvePortConflicts({
      port: 15702,
      targetPackage: 'net.monoloco.keyboarddemo',
      adb: runner,
    });

    expect(stopped).toEqual([]);
    expect(report.stopped).toEqual([]);
    expect(report.skipped).toEqual([{ uid: 99999, packageName: null }]);
  });

  it('returns an empty report when nothing is listening on the port', async () => {
    const runner = makeRunner({ tcp4: '  sl ...\n' });

    const report = await resolvePortConflicts({
      port: 15702,
      targetPackage: 'net.monoloco.keyboarddemo',
      adb: runner,
    });

    expect(report.stopped).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});
