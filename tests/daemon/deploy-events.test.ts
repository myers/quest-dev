import { describe, it, expect } from 'vitest';
import { parseIncrementalProgress, type ProgressUpdate, collectDeployEvents, deploy, type DeployEvent } from '../../src/daemon/deploy.js';
import { vi } from 'vitest';

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

  it('emits already_enabled when stay-awake is already on', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, enable: vi.fn() } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'already_enabled' });
    expect(stayAwake.enable).not.toHaveBeenCalled();
    // Last event is still the existing APK-missing failure.
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false, error: expect.stringContaining('APK not found') });
  });

  it('emits enabling then enabled when stay-awake activates successfully', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: false, enable: vi.fn().mockResolvedValue(undefined) } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'enabling' });
    expect(events[1]).toMatchObject({ type: 'stay_awake', status: 'enabled' });
    expect(stayAwake.enable).toHaveBeenCalledWith('1234');
  });

  it('emits failed and aborts deploy when stay-awake activation throws', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = {
      isEnabled: false,
      enable: vi.fn().mockRejectedValue(new Error('PIN rejected')),
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
    const stayAwake = { isEnabled: true, enable: vi.fn() } as any;

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
});
