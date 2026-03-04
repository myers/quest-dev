import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { loadConfig, loadPin } from '../src/utils/config.js';

vi.mock('fs');

const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadConfig', () => {
  it('returns empty object when no config files exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('reads .quest-dev.json from cwd when present', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('.quest-dev.json')) {
        return JSON.stringify({ pin: '1234' });
      }
      throw new Error('ENOENT');
    });

    const config = loadConfig();
    expect(config.pin).toBe('1234');
  });

  it('merges configs: local file wins over global file', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('.quest-dev.json')) {
        return JSON.stringify({ pin: 'local-pin', idleTimeout: 5000 });
      }
      if (String(path).endsWith('config.json')) {
        return JSON.stringify({ pin: 'global-pin', lowBattery: 15 });
      }
      throw new Error('ENOENT');
    });

    const config = loadConfig();
    expect(config.pin).toBe('local-pin');
    expect(config.idleTimeout).toBe(5000);
    expect(config.lowBattery).toBe(15);
  });
});

describe('loadPin', () => {
  it('returns CLI pin when provided', () => {
    // Should not even read config files
    const pin = loadPin('cli-pin');
    expect(pin).toBe('cli-pin');
  });

  it('falls back to config file pin', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('.quest-dev.json')) {
        return JSON.stringify({ pin: 'config-pin' });
      }
      throw new Error('ENOENT');
    });

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
