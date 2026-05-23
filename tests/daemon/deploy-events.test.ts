import { describe, it, expect, beforeEach } from 'vitest';
import { parseIncrementalProgress, type ProgressUpdate, collectDeployEvents, deploy, type DeployEvent } from '../../src/daemon/deploy.js';
import { vi } from 'vitest';
import * as adbModuleNs from '../../src/utils/adb.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parseIncrementalProgress', () => {
  it('emits one update per ~10% of total, plus a final transferred update', () => {
    const updates: ProgressUpdate[] = [];
    const parser = parseIncrementalProgress((u) => updates.push(u));

    // 100 blocks total — should emit at 10, 20, 30, … 100, then a final "transferred"
    for (let n = 1; n <= 100; n++) {
      parser.feed(`in priority: ${n} of 100\n`);
    }
    parser.end();

    const progress = updates.filter((u) => u.kind === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(9); // at least 9 ticks at 10%
    expect(progress.length).toBeLessThanOrEqual(11);
    expect(progress[0]).toMatchObject({ kind: 'progress', blocks: expect.any(Number), totalBlocks: 100 });

    const transferred = updates.find((u) => u.kind === 'transferred');
    expect(transferred).toBeDefined();
    expect(transferred).toMatchObject({ kind: 'transferred', blocksTransferred: 100, totalBlocks: 100 });
  });

  it('emits no updates when there is no incremental output', () => {
    const updates: ProgressUpdate[] = [];
    const parser = parseIncrementalProgress((u) => updates.push(u));
    parser.feed('Performing Streamed Install\nSuccess\n');
    parser.end();
    expect(updates).toEqual([]);
  });

  it('handles a chunk that splits a match across feed boundaries', () => {
    const updates: ProgressUpdate[] = [];
    const parser = parseIncrementalProgress((u) => updates.push(u));
    parser.feed('in priority: 50 of ');
    parser.feed('100\n');
    parser.end();
    // At 50% we cross the 10% threshold
    const progress = updates.filter((u) => u.kind === 'progress');
    expect(progress.length).toBe(1);
    expect(progress[0]).toMatchObject({ blocks: 50, totalBlocks: 100, pct: 50 });
  });
});

describe('DeployEvent type', () => {
  it('exposes the expected event shapes (compile-time check)', () => {
    const events: DeployEvent[] = [
      { type: 'adb_health', status: 'reconnecting' },
      { type: 'adb_health', status: 'restarting_server' },
      { type: 'adb_health', status: 'recovered', via: 'reconnect' },
      { type: 'adb_health', status: 'failed', error: 'oops' },
      { type: 'stay_awake', status: 'already_enabled' },
      { type: 'stay_awake', status: 'enabling' },
      { type: 'stay_awake', status: 'enabled' },
      { type: 'stay_awake', status: 'failed', error: 'oops' },
      { type: 'started', package: 'com.example', apkSizeMB: 1, incremental: true },
      { type: 'install_progress', blocks: 1, totalBlocks: 10, pct: 10 },
      { type: 'installed', installSecs: 1.0 },
      { type: 'launching' },
      { type: 'crash_check', waitMs: 5000 },
      { type: 'done', ok: true, package: 'com.example', crashed: false, logcatFile: '/tmp/x' },
    ];
    expect(events).toHaveLength(14);
  });

});

describe('deploy() event sequence', () => {
  const fakeLogcat = () =>
    ({
      start: vi.fn(),
      status: () => ({ file: '/tmp/fake.log' }),
      scanForCrash: () => ({ crashed: false, lines: [] }),
      readTail: () => [],
    }) as any;

  // Default to healthy ADB so existing tests don't shell out to real adb.
  // Individual tests can override this spy via vi.spyOn(...).mockImplementation.
  beforeEach(() => {
    vi.spyOn(adbModuleNs, 'ensureAdbHealthy').mockResolvedValue({ kind: 'healthy' });
  });

  it('emits already_enabled when stay-awake is already on', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, turnOn: vi.fn() } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'already_enabled' });
    expect(stayAwake.turnOn).not.toHaveBeenCalled();
    // Last event is still the existing APK-missing failure.
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false, error: expect.stringContaining('APK not found') });
  });

  it('emits enabling then enabled when stay-awake activates successfully', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: false, turnOn: vi.fn().mockResolvedValue(undefined) } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'enabling' });
    expect(events[1]).toMatchObject({ type: 'stay_awake', status: 'enabled' });
    expect(stayAwake.turnOn).toHaveBeenCalledWith('1234');
  });

  it('emits failed and aborts deploy when stay-awake activation throws', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = {
      isEnabled: false,
      turnOn: vi.fn().mockRejectedValue(new Error('PIN rejected')),
    } as any;
    const logcat = fakeLogcat();

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      logcat,
    );

    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'enabling' });
    expect(events[1]).toMatchObject({ type: 'stay_awake', status: 'failed', error: 'PIN rejected' });
    expect(events[2]).toMatchObject({
      type: 'done',
      ok: false,
      crashed: false,
      error: expect.stringContaining('Stay-awake failed'),
    });
    // Deploy must NOT have proceeded to install.
    expect(logcat.start).not.toHaveBeenCalled();
  });

  it('emits a done event for an APK that does not exist', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, turnOn: vi.fn() } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events.at(-1)).toMatchObject({
      type: 'done',
      ok: false,
      crashed: false,
      error: expect.stringContaining('APK not found'),
    });
  });

  it('aborts with adb_health failed + done when ensureAdbHealthy returns failed', async () => {
    const adbModule = await import('../../src/utils/adb.js');
    const spy = vi
      .spyOn(adbModule, 'ensureAdbHealthy')
      .mockImplementation(async (events) => {
        events?.onFailed?.('probe timed out');
        return { kind: 'failed', error: 'probe timed out' };
      });

    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, turnOn: vi.fn() } as any;

    await deploy(
      { apkPath: '/some/path.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events[0]).toMatchObject({ type: 'adb_health', status: 'failed', error: 'probe timed out' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      ok: false,
      crashed: false,
      error: expect.stringContaining('ADB unresponsive'),
    });
    // Stay-awake must NOT have been touched.
    expect(stayAwake.turnOn).not.toHaveBeenCalled();
    // Only adb_health + done should have been emitted (no stay_awake).
    expect(events.find((e) => e.type === 'stay_awake')).toBeUndefined();
    spy.mockRestore();
  });

  it('emits no adb_health events when ADB is healthy', async () => {
    const adbModule = await import('../../src/utils/adb.js');
    const spy = vi
      .spyOn(adbModule, 'ensureAdbHealthy')
      .mockResolvedValue({ kind: 'healthy' });

    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, turnOn: vi.fn() } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events.find((e) => e.type === 'adb_health')).toBeUndefined();
    // First event should be the existing already_enabled stay-awake event.
    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'already_enabled' });
    spy.mockRestore();
  });

  it('emits a port_conflict_resolved event before install when an orphan app holds the BRP port', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, turnOn: vi.fn() } as any;

    // Write a real (non-APK) file so deploy() passes its existsSync check.
    // We provide `targetPackage` to bypass APK package-name extraction,
    // which would fail on this fake file.
    const fakeApk = join(tmpdir(), `port-conflict-test-${process.pid}.apk`);
    writeFileSync(fakeApk, 'not-a-real-apk');

    const forceStopped: string[] = [];
    const adb = vi.fn(async (args: string[]) => {
      if (args.includes('cat') && args.includes('/proc/net/tcp')) {
        return [
          '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
          '   0: 00000000:3D56 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10183        0 1955097 1 0000000000000000 99 0 0 10 0',
        ].join('\n');
      }
      if (args.includes('cat') && args.includes('/proc/net/tcp6')) return '';
      if (args.includes('pm') && args.includes('list')) {
        return 'package:com.bevychromium uid:10183\n';
      }
      if (args.includes('am') && args.includes('force-stop')) {
        forceStopped.push(args[args.indexOf('force-stop') + 1]);
        return '';
      }
      // Anything else (install, launch, pidof) — return empty so deploy()
      // bails out with its own non-port-conflict error path.
      return '';
    });

    try {
      await deploy(
        {
          apkPath: fakeApk,
          pin: '1234',
          onEvent: push,
          adb,
          targetPackage: 'net.monoloco.keyboarddemo',
          debuggingPort: 15702,
        },
        stayAwake,
        fakeLogcat(),
      );
    } finally {
      try { unlinkSync(fakeApk); } catch { /* ignore */ }
    }

    const portEvent = events.find((e) => e.type === 'port_conflict_resolved');
    expect(portEvent).toBeDefined();
    if (portEvent && portEvent.type === 'port_conflict_resolved') {
      expect(portEvent.port).toBe(15702);
      expect(portEvent.stopped).toEqual([
        { packageName: 'com.bevychromium', uid: 10183 },
      ]);
    }
    expect(forceStopped).toEqual(['com.bevychromium']);
  });
});
