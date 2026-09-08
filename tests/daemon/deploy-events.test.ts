import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { collectDeployEvents, deploy, type DeployEvent } from '../../src/daemon/deploy.js';
import { vi } from 'vitest';
import * as adbModuleNs from '../../src/utils/adb.js';
import * as exec from '../../src/utils/exec.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// deploy() routes its plain `adb <args>` calls through the injected runner,
// but the install and the pidof probe need an exit code and go through
// execCommandFull. Stub the module so no test in this file shells out to a
// real adb (same pattern as tests/adb-health.test.ts).
vi.mock('../../src/utils/exec.js');

describe('DeployEvent type', () => {
  it('exposes the expected event shapes (compile-time check)', () => {
    const events: DeployEvent[] = [
      { type: 'adb_health', status: 'reconnecting' },
      { type: 'adb_health', status: 'restarting_server' },
      { type: 'adb_health', status: 'recovered', via: 'reconnect' },
      { type: 'adb_health', status: 'failed', error: 'oops' },
      { type: 'stay_awake', status: 'enabling' },
      { type: 'stay_awake', status: 'enabled' },
      { type: 'stay_awake', status: 'failed', error: 'oops' },
      { type: 'started', package: 'com.example', apkSizeMB: 1, incremental: true },
      { type: 'installed', installSecs: 1.0 },
      { type: 'launching' },
      { type: 'crash_check', waitMs: 5000 },
      { type: 'done', ok: true, package: 'com.example', crashed: false, logcatFile: '/tmp/x' },
    ];
    expect(events).toHaveLength(12);
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

  it('re-applies stay-awake even when the daemon believes it is already on', async () => {
    // Regression: the daemon's in-memory flag goes stale whenever anything
    // else touches com.oculus.rc, and deploy used to skip turnOn() on it —
    // printing "Stay-awake: already enabled" over an unprotected headset.
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, turnOn: vi.fn().mockResolvedValue(undefined) } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(stayAwake.turnOn).toHaveBeenCalledWith('1234');
    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'enabling' });
    expect(events[1]).toMatchObject({ type: 'stay_awake', status: 'enabled' });
    expect(events.find((e) => (e as any).status === 'already_enabled')).toBeUndefined();
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
    const stayAwake = { isEnabled: true, turnOn: vi.fn().mockResolvedValue(undefined) } as any;

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
    const stayAwake = { isEnabled: true, turnOn: vi.fn().mockResolvedValue(undefined) } as any;

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
    const stayAwake = { isEnabled: true, turnOn: vi.fn().mockResolvedValue(undefined) } as any;

    await deploy(
      { apkPath: '/definitely/does/not/exist.apk', pin: '1234', onEvent: push },
      stayAwake,
      fakeLogcat(),
    );

    expect(events.find((e) => e.type === 'adb_health')).toBeUndefined();
    // First event is the stay-awake apply, which deploy always performs.
    expect(events[0]).toMatchObject({ type: 'stay_awake', status: 'enabling' });
    spy.mockRestore();
  });

  it('emits a port_conflict_resolved event before install when an orphan app holds the BRP port', async () => {
    const { events, push } = collectDeployEvents();
    const stayAwake = { isEnabled: true, turnOn: vi.fn().mockResolvedValue(undefined) } as any;

    // Write a real (non-APK) file so deploy() passes its existsSync check.
    // We provide `targetPackage` to bypass APK package-name extraction,
    // which would fail on this fake file.
    const fakeApk = join(tmpdir(), `port-conflict-test-${process.pid}.apk`);
    writeFileSync(fakeApk, 'not-a-real-apk');

    // Installing a 14-byte "APK" fails on a real device; make that hermetic
    // so deploy() bails on its own error path instead of waiting on adb.
    vi.mocked(exec).execCommandFull.mockResolvedValue({
      stdout: '',
      stderr: 'Failure [INSTALL_PARSE_FAILED_NOT_APK]',
      code: 1,
    });

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
    // The orphan is stopped by the conflict scan; the target package by
    // deploy's own force-stop -- both through the injected runner.
    expect(forceStopped).toEqual(['com.bevychromium', 'net.monoloco.keyboarddemo']);
  });
});

// The seam these tests defend: deploy() must reach the real `adb` binary from
// nowhere. Before this, the install spawn, the pidof probe and
// waitForPanelComposited each shelled out directly, so the first happy-path
// test anyone wrote hung on a real device. Every test below stubs the exec
// module to hang forever — any path that escapes the injected runner fails on
// the vitest timeout instead of quietly passing.
describe('deploy() happy path through the injected adb seam', () => {
  const COMPOSITED_TASK =
    '    * Task{7a80656 #19817 type=standard A=10064:net.monoloco.chromium U=0 ' +
    'rootTaskId=19816 visible=true visibleRequested=true mode=multi-window sz=1}';

  const fakeLogcat = () =>
    ({
      start: vi.fn(),
      status: () => ({ file: '/dev/null' }),
      scanForCrash: () => ({ crashed: false, lines: [] }),
      readTail: () => [],
    }) as any;

  type ExecOpts = { env?: NodeJS.ProcessEnv; onStderr?: (chunk: string) => void };

  /** adb stand-in: a healthy device, with incremental progress on install. */
  const fakeAdbExec = (over: Record<string, { stdout?: string; stderr?: string; code?: number }> = {}) =>
    vi.fn(async (args: string[], opts?: ExecOpts) => {
      const cmd = args.join(' ');
      const hit = Object.keys(over).find((k) => cmd.includes(k));
      if (args[0] === 'install' && !hit) {
        for (let n = 10; n <= 100; n += 10) opts?.onStderr?.(`in priority: ${n} of 100\n`);
        return { stdout: 'Success\n', stderr: '', code: 0 };
      }
      if (hit) return { stdout: '', stderr: '', code: 0, ...over[hit] };
      if (cmd.includes('pidof')) return { stdout: '12345\n', stderr: '', code: 0 };
      if (cmd.includes('dumpsys activity activities')) return { stdout: COMPOSITED_TASK, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

  let apk = '';
  beforeEach(() => {
    // Any escape from the seam blocks forever -> the test times out.
    vi.mocked(exec).execCommandFull.mockClear();
    vi.mocked(exec).execCommandFull.mockImplementation(() => new Promise(() => {}));
    vi.mocked(exec).execCommand.mockImplementation(() => new Promise(() => {}));
    apk = join(tmpdir(), `deploy-seam-${process.pid}.apk`);
    writeFileSync(apk, 'not-a-real-apk');
  });
  afterEach(() => {
    for (const f of [apk, `${apk}.idsig`]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  const run = async (adbExec: ReturnType<typeof fakeAdbExec>) => {
    const { events, push } = collectDeployEvents();
    await deploy(
      {
        apkPath: apk,
        pin: '1234',
        crashWaitMs: 0,
        onEvent: push,
        adb: vi.fn(async () => ''),
        adbExec,
        targetPackage: 'net.monoloco.chromium',
      },
      { isEnabled: true, turnOn: vi.fn().mockResolvedValue(undefined) } as any,
      fakeLogcat(),
    );
    return events;
  };

  it('runs install -> pidof -> panel-composited to done ok with adb stubbed out', async () => {
    writeFileSync(`${apk}.idsig`, 'sig'); // incremental install path
    const adbExec = fakeAdbExec();
    const events = await run(adbExec);

    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true, package: 'net.monoloco.chromium' });
    const cmds = adbExec.mock.calls.map((c) => c[0].join(' '));
    expect(cmds).toContainEqual(expect.stringContaining('install -r'));
    expect(cmds).toContainEqual('shell pidof net.monoloco.chromium');
    expect(cmds).toContainEqual('shell dumpsys activity activities');
    // Nothing fell back to the real binary.
    expect(vi.mocked(exec).execCommandFull).not.toHaveBeenCalled();
  });

  // Regression: deploy used to run the install under ADB_TRACE=incremental and
  // turn adb's MISSING-BLOCK trace into a "N/M blocks (~KKB)" summary. Those
  // numbers are a priority-vector index and that vector's size, so the byte
  // figure was fiction. No trace, no numbers.
  it('does not fabricate a transferred-bytes figure from adb trace output', async () => {
    writeFileSync(`${apk}.idsig`, 'sig'); // incremental install path
    const adbExec = fakeAdbExec();
    const events = await run(adbExec);

    const installCall = adbExec.mock.calls.find((c) => c[0][0] === 'install');
    expect(installCall?.[1]?.env).toBeUndefined();
    expect(events.find((e) => e.type === 'installed')).toEqual({
      type: 'installed', installSecs: expect.any(Number),
    });
  });

  it('installs plainly when there is no .idsig', async () => {
    const adbExec = fakeAdbExec();
    const events = await run(adbExec);

    const installCall = adbExec.mock.calls.find((c) => c[0][0] === 'install');
    expect(installCall?.[1]).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: true });
  });

  it('reports the process as dead when the injected pidof probe fails', async () => {
    const events = await run(fakeAdbExec({ pidof: { stdout: '', stderr: '', code: 1 } }));
    expect(events.at(-1)).toMatchObject({
      type: 'done', ok: false, crashed: true,
      error: expect.stringContaining('Process not running'),
    });
  });

  it('fails the deploy when the injected install returns non-zero', async () => {
    const events = await run(fakeAdbExec({ install: { stderr: 'Failure [INSTALL_FAILED_INVALID_APK]', code: 1 } }));
    expect(events.at(-1)).toMatchObject({
      type: 'done', ok: false, error: expect.stringContaining('Install failed (exit 1)'),
    });
  });
});
