import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkADBDevices, setAdbDevice } from '../src/utils/adb.js';
import * as exec from '../src/utils/exec.js';

vi.mock('../src/utils/exec.js');

const mockedExec = vi.mocked(exec);

const HEADER = 'List of devices attached\n';
const DEVICE_LINE = (id: string) => `${id}\tdevice`;

beforeEach(() => {
  vi.resetAllMocks();
  setAdbDevice(undefined);
});

describe('checkADBDevices auto-connect for TCP targets', () => {
  it('auto-connects when configured TCP device is missing from adb devices', async () => {
    setAdbDevice('192.168.1.10:5555');

    // First `adb devices` call: target absent. After connect: target present.
    let listCallCount = 0;
    mockedExec.execCommand.mockImplementation(async (cmd, args) => {
      expect(cmd).toBe('adb');
      expect(args).toEqual(['devices']);
      listCallCount++;
      if (listCallCount === 1) {
        return HEADER + DEVICE_LINE('emulator-5554') + '\n';
      }
      return HEADER + DEVICE_LINE('192.168.1.10:5555') + '\n';
    });
    mockedExec.execCommandFull.mockImplementation(async (cmd, args) => {
      expect(cmd).toBe('adb');
      expect(args).toEqual(['connect', '192.168.1.10:5555']);
      return { stdout: 'connected to 192.168.1.10:5555', stderr: '', code: 0 };
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await checkADBDevices();

    expect(result).toBe(true);
    expect(listCallCount).toBe(2);
    expect(mockedExec.execCommandFull).toHaveBeenCalledOnce();
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('not connected, running: adb connect 192.168.1.10:5555'),
    );

    consoleLog.mockRestore();
  });

  it('exits when TCP target is missing and adb connect fails', async () => {
    setAdbDevice('192.168.1.10:5555');

    mockedExec.execCommand.mockResolvedValue(HEADER + DEVICE_LINE('emulator-5554') + '\n');
    mockedExec.execCommandFull.mockResolvedValue({
      stdout: '',
      stderr: 'unable to connect',
      code: 1,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkADBDevices()).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it('does not attempt connect for non-TCP targets (USB serial)', async () => {
    setAdbDevice('1WMHH123456789');

    mockedExec.execCommand.mockResolvedValue(HEADER + DEVICE_LINE('emulator-5554') + '\n');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkADBDevices()).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedExec.execCommandFull).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('does not attempt connect when TCP target is already in the device list', async () => {
    setAdbDevice('192.168.1.10:5555');

    mockedExec.execCommand.mockResolvedValue(HEADER + DEVICE_LINE('192.168.1.10:5555') + '\n');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await checkADBDevices();

    expect(result).toBe(true);
    expect(mockedExec.execCommand).toHaveBeenCalledOnce();
    expect(mockedExec.execCommandFull).not.toHaveBeenCalled();
  });
});
