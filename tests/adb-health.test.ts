import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ensureAdbHealthy, setAdbDevice } from '../src/utils/adb.js';
import * as exec from '../src/utils/exec.js';

vi.mock('../src/utils/exec.js');

const mockedExec = vi.mocked(exec);

interface MockOutcome {
  args: string[];
  result: { stdout?: string; stderr?: string; code: number } | { error: string };
}

function configureExec(outcomes: MockOutcome[]) {
  let i = 0;
  mockedExec.execCommandFull.mockImplementation(async (cmd, args) => {
    expect(cmd).toBe('adb');
    const expected = outcomes[i];
    if (!expected) {
      throw new Error(`unexpected adb call ${i}: ${args?.join(' ')}`);
    }
    expect(args).toEqual(expected.args);
    i++;
    if ('error' in expected.result) {
      return { stdout: '', stderr: expected.result.error, code: 1 };
    }
    return {
      stdout: expected.result.stdout ?? '',
      stderr: expected.result.stderr ?? '',
      code: expected.result.code,
    };
  });
}

/**
 * Stub `adb devices` (which uses execCommand, not execCommandFull) to return
 * a list with the given target marked as "device". Default for tests that
 * exercise the "device already listed, just stale" recovery path.
 */
function stubAdbDevicesWith(target: string) {
  mockedExec.execCommand.mockImplementation(async (cmd, args) => {
    expect(cmd).toBe('adb');
    expect(args).toEqual(['devices']);
    return `List of devices attached\n${target}\tdevice\n`;
  });
}

/** Stub `adb devices` to return an empty device list (target not connected). */
function stubAdbDevicesEmpty() {
  mockedExec.execCommand.mockImplementation(async (cmd, args) => {
    expect(cmd).toBe('adb');
    expect(args).toEqual(['devices']);
    return 'List of devices attached\n';
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setAdbDevice(undefined);
});

describe('ensureAdbHealthy', () => {
  it('returns healthy when first probe succeeds (no callbacks fired)', async () => {
    setAdbDevice('192.168.1.10:5555');
    configureExec([
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 0 } },
    ]);

    const callbacks = {
      onReconnecting: vi.fn(),
      onRestartingServer: vi.fn(),
      onRecovered: vi.fn(),
      onFailed: vi.fn(),
    };
    const result = await ensureAdbHealthy(callbacks);

    expect(result).toEqual({ kind: 'healthy' });
    expect(callbacks.onReconnecting).not.toHaveBeenCalled();
    expect(callbacks.onRestartingServer).not.toHaveBeenCalled();
    expect(callbacks.onRecovered).not.toHaveBeenCalled();
    expect(callbacks.onFailed).not.toHaveBeenCalled();
  });

  it('connects when target is TCP but not yet in adb devices', async () => {
    setAdbDevice('192.168.1.10:5555');
    stubAdbDevicesEmpty();
    configureExec([
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 1 } },
      { args: ['connect', '192.168.1.10:5555'], result: { code: 0 } },
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 0 } },
    ]);

    const callbacks = {
      onConnecting: vi.fn(),
      onReconnecting: vi.fn(),
      onRestartingServer: vi.fn(),
      onRecovered: vi.fn(),
      onFailed: vi.fn(),
    };
    const result = await ensureAdbHealthy(callbacks);

    expect(result).toEqual({ kind: 'recovered', via: 'connect' });
    expect(callbacks.onConnecting).toHaveBeenCalledOnce();
    expect(callbacks.onReconnecting).not.toHaveBeenCalled();
    expect(callbacks.onRecovered).toHaveBeenCalledWith('connect');
  });

  it('recovers via TCP reconnect when probe fails and device is already listed', async () => {
    setAdbDevice('192.168.1.10:5555');
    stubAdbDevicesWith('192.168.1.10:5555');
    configureExec([
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 1 } },
      { args: ['disconnect', '192.168.1.10:5555'], result: { code: 0 } },
      { args: ['connect', '192.168.1.10:5555'], result: { code: 0 } },
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 0 } },
    ]);

    const callbacks = {
      onConnecting: vi.fn(),
      onReconnecting: vi.fn(),
      onRestartingServer: vi.fn(),
      onRecovered: vi.fn(),
      onFailed: vi.fn(),
    };
    const result = await ensureAdbHealthy(callbacks);

    expect(result).toEqual({ kind: 'recovered', via: 'reconnect' });
    expect(callbacks.onReconnecting).toHaveBeenCalledOnce();
    expect(callbacks.onConnecting).not.toHaveBeenCalled();
    expect(callbacks.onRecovered).toHaveBeenCalledWith('reconnect');
    expect(callbacks.onRestartingServer).not.toHaveBeenCalled();
    expect(callbacks.onFailed).not.toHaveBeenCalled();
  });

  it('falls through to kill-server when reconnect does not help', async () => {
    setAdbDevice('192.168.1.10:5555');
    stubAdbDevicesWith('192.168.1.10:5555');
    configureExec([
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 1 } },
      { args: ['disconnect', '192.168.1.10:5555'], result: { code: 0 } },
      { args: ['connect', '192.168.1.10:5555'], result: { code: 0 } },
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 1 } },
      { args: ['kill-server'], result: { code: 0 } },
      { args: ['start-server'], result: { code: 0 } },
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 0 } },
    ]);

    const callbacks = {
      onConnecting: vi.fn(),
      onReconnecting: vi.fn(),
      onRestartingServer: vi.fn(),
      onRecovered: vi.fn(),
      onFailed: vi.fn(),
    };
    const result = await ensureAdbHealthy(callbacks);

    expect(result).toEqual({ kind: 'recovered', via: 'kill-server' });
    expect(callbacks.onReconnecting).toHaveBeenCalledOnce();
    expect(callbacks.onRestartingServer).toHaveBeenCalledOnce();
    expect(callbacks.onRecovered).toHaveBeenCalledWith('kill-server');
    expect(callbacks.onFailed).not.toHaveBeenCalled();
  });

  it('skips reconnect when no target device is set (USB)', async () => {
    setAdbDevice(undefined);
    configureExec([
      { args: ['shell', 'true'], result: { code: 1 } },
      { args: ['kill-server'], result: { code: 0 } },
      { args: ['start-server'], result: { code: 0 } },
      { args: ['shell', 'true'], result: { code: 0 } },
    ]);

    const callbacks = {
      onReconnecting: vi.fn(),
      onRestartingServer: vi.fn(),
      onRecovered: vi.fn(),
      onFailed: vi.fn(),
    };
    const result = await ensureAdbHealthy(callbacks);

    expect(result).toEqual({ kind: 'recovered', via: 'kill-server' });
    expect(callbacks.onReconnecting).not.toHaveBeenCalled();
    expect(callbacks.onRestartingServer).toHaveBeenCalledOnce();
  });

  it('skips reconnect when target device is non-IP serial', async () => {
    setAdbDevice('1WMHH123456789');
    configureExec([
      { args: ['-s', '1WMHH123456789', 'shell', 'true'], result: { code: 1 } },
      { args: ['kill-server'], result: { code: 0 } },
      { args: ['start-server'], result: { code: 0 } },
      { args: ['-s', '1WMHH123456789', 'shell', 'true'], result: { code: 0 } },
    ]);

    const callbacks = { onReconnecting: vi.fn(), onRestartingServer: vi.fn(), onRecovered: vi.fn(), onFailed: vi.fn() };
    const result = await ensureAdbHealthy(callbacks);

    expect(result).toEqual({ kind: 'recovered', via: 'kill-server' });
    expect(callbacks.onReconnecting).not.toHaveBeenCalled();
    expect(callbacks.onRestartingServer).toHaveBeenCalledOnce();
  });

  it('returns failed and fires onFailed when all recovery fails', async () => {
    setAdbDevice('192.168.1.10:5555');
    stubAdbDevicesWith('192.168.1.10:5555');
    configureExec([
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 1, stderr: 'no devices' } },
      { args: ['disconnect', '192.168.1.10:5555'], result: { code: 0 } },
      { args: ['connect', '192.168.1.10:5555'], result: { code: 0 } },
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 1 } },
      { args: ['kill-server'], result: { code: 0 } },
      { args: ['start-server'], result: { code: 0 } },
      { args: ['-s', '192.168.1.10:5555', 'shell', 'true'], result: { code: 1, stderr: 'still dead' } },
    ]);

    const callbacks = { onConnecting: vi.fn(), onReconnecting: vi.fn(), onRestartingServer: vi.fn(), onRecovered: vi.fn(), onFailed: vi.fn() };
    const result = await ensureAdbHealthy(callbacks);

    expect(result.kind).toBe('failed');
    expect(callbacks.onFailed).toHaveBeenCalledOnce();
    expect(callbacks.onRecovered).not.toHaveBeenCalled();
  });

  it('treats probe timeout as failure and triggers recovery', async () => {
    setAdbDevice('192.168.1.10:5555');
    stubAdbDevicesWith('192.168.1.10:5555');
    let probeCalls = 0;
    mockedExec.execCommandFull.mockImplementation(async (_cmd, args) => {
      const argstr = (args ?? []).join(' ');
      if (argstr.includes('shell true')) {
        probeCalls++;
        if (probeCalls === 1) {
          // Hang past 3s timeout — return a never-resolving promise
          return new Promise(() => {}) as any;
        }
        return { stdout: '', stderr: '', code: 0 };
      }
      // disconnect/connect/etc.
      return { stdout: '', stderr: '', code: 0 };
    });

    const callbacks = { onReconnecting: vi.fn(), onRestartingServer: vi.fn(), onRecovered: vi.fn(), onFailed: vi.fn() };
    const result = await ensureAdbHealthy(callbacks);

    expect(result).toEqual({ kind: 'recovered', via: 'reconnect' });
    expect(callbacks.onReconnecting).toHaveBeenCalledOnce();
  }, 10000); // give vitest 10s for this one
});
