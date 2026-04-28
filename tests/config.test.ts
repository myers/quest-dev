import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { loadConfig, loadPin, tryLoadPin } from '../src/utils/config.js';

vi.mock('fs');

const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadConfig', () => {
  it('returns empty object when no config file exists', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('reads ~/.config/quest-dev/config.json', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('config.json')) {
        return JSON.stringify({ pin: '1234', port: 8091 });
      }
      throw new Error('ENOENT');
    });

    const config = loadConfig();
    expect(config.pin).toBe('1234');
    expect(config.port).toBe(8091);
  });

  it('returns all config fields', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      pin: 'test-pin',
      port: 9000,
      device: '192.168.1.100',
      idleTimeout: 5000,
      lowBattery: 15,
    }));

    const config = loadConfig();
    expect(config.pin).toBe('test-pin');
    expect(config.port).toBe(9000);
    expect(config.device).toBe('192.168.1.100');
    expect(config.idleTimeout).toBe(5000);
    expect(config.lowBattery).toBe(15);
  });
});

describe('loadPin', () => {
  it('returns CLI pin when provided', () => {
    const pin = loadPin('cli-pin');
    expect(pin).toBe('cli-pin');
  });

  it('falls back to config file pin', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ pin: 'config-pin' }));

    const pin = loadPin();
    expect(pin).toBe('config-pin');
  });

  it('exits with error when no pin found', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => loadPin()).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
    mockError.mockRestore();
  });
});

describe('tryLoadPin', () => {
  it('returns CLI pin when provided', () => {
    expect(tryLoadPin('cli-pin')).toBe('cli-pin');
  });

  it('falls back to config file pin', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ pin: 'config-pin' }));
    expect(tryLoadPin()).toBe('config-pin');
  });

  it('returns null when no pin is configured (does not exit)', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit should not be called');
    });

    expect(tryLoadPin()).toBeNull();
    expect(mockExit).not.toHaveBeenCalled();

    mockExit.mockRestore();
  });
});
