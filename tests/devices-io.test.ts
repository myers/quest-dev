import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadDevices, saveDevices } from '../src/utils/devices.js';

let dir: string;
let savedXdg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qd-devices-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadDevices/saveDevices', () => {
  it('returns an empty map when no file exists', () => {
    expect(loadDevices()).toEqual({});
  });

  it('round-trips a saved map', () => {
    saveDevices({ quest3: { address: '127.0.0.1:5555', serial: 'S1' } });
    expect(loadDevices()).toEqual({ quest3: { address: '127.0.0.1:5555', serial: 'S1' } });
  });

  it('returns an empty map for corrupt JSON', () => {
    saveDevices({ quest3: { address: 'a', serial: 's' } });
    const path = join(dir, 'quest-dev', 'devices.json');
    require('fs').writeFileSync(path, '{ not json');
    expect(loadDevices()).toEqual({});
  });
});
