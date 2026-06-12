import { describe, it, expect, afterEach } from 'vitest';
import { runtimeDir, stateDir, configDir, dataDir, sanitizeSerial } from '../src/utils/paths.js';

const ENV_KEYS = ['XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HOME'];
const saved: Record<string, string | undefined> = {};
function setEnv(values: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; }
  for (const k of ENV_KEYS) { delete process.env[k]; }
  process.env.HOME = '/home/tester';
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
  }
});

describe('XDG path resolver', () => {
  it('uses XDG_RUNTIME_DIR for runtimeDir when set', () => {
    setEnv({ XDG_RUNTIME_DIR: '/run/user/1000' });
    expect(runtimeDir()).toBe('/run/user/1000/quest-dev');
  });

  it('falls back to XDG_STATE_HOME/run when XDG_RUNTIME_DIR is unset', () => {
    setEnv({ XDG_STATE_HOME: '/home/tester/.local/state' });
    expect(runtimeDir()).toBe('/home/tester/.local/state/quest-dev/run');
  });

  it('falls back to ~/.local/state/quest-dev/run when neither runtime nor state home is set', () => {
    setEnv({});
    expect(runtimeDir()).toBe('/home/tester/.local/state/quest-dev/run');
  });

  it('resolves stateDir from XDG_STATE_HOME with HOME fallback', () => {
    setEnv({ XDG_STATE_HOME: '/x/state' });
    expect(stateDir()).toBe('/x/state/quest-dev');
    setEnv({});
    expect(stateDir()).toBe('/home/tester/.local/state/quest-dev');
  });

  it('resolves configDir from XDG_CONFIG_HOME with HOME fallback', () => {
    setEnv({ XDG_CONFIG_HOME: '/x/config' });
    expect(configDir()).toBe('/x/config/quest-dev');
    setEnv({});
    expect(configDir()).toBe('/home/tester/.config/quest-dev');
  });

  it('resolves dataDir from XDG_DATA_HOME with HOME fallback', () => {
    setEnv({ XDG_DATA_HOME: '/x/data' });
    expect(dataDir()).toBe('/x/data/quest-dev');
    setEnv({});
    expect(dataDir()).toBe('/home/tester/.local/share/quest-dev');
  });
});

describe('sanitizeSerial', () => {
  it('replaces filesystem-hostile characters with underscore', () => {
    expect(sanitizeSerial('192.168.1.50:5555')).toBe('192_168_1_50_5555');
  });
  it('leaves a clean USB serial unchanged', () => {
    expect(sanitizeSerial('1WMHHA1234567')).toBe('1WMHHA1234567');
  });
  it('is idempotent', () => {
    const once = sanitizeSerial('a.b:c');
    expect(sanitizeSerial(once)).toBe(once);
  });
});
