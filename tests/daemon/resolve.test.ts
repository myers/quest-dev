import { describe, it, expect } from 'vitest';
import { selectRef } from '../../src/daemon/resolve.js';

describe('selectRef (precedence)', () => {
  it('prefers explicit cliDevice (even over multiple connected)', () => {
    expect(selectRef('cli', 'env', 'cfg', ['a', 'b'])).toBe('cli');
  });
  it('falls back to QUEST_DEVICE env (even over multiple connected)', () => {
    expect(selectRef(undefined, 'env', 'cfg', ['a', 'b'])).toBe('env');
  });
  it('falls back to config.device when at most one device is connected', () => {
    expect(selectRef(undefined, undefined, 'cfg', ['only'])).toBe('cfg');
    expect(selectRef(undefined, undefined, 'cfg', [])).toBe('cfg');
  });
  it('does NOT silently use config.device when multiple devices are connected', () => {
    // The multi-device guard wins over a saved config.device: an explicit
    // choice is required rather than quietly targeting one of several headsets.
    expect(() => selectRef(undefined, undefined, 'cfg', ['a', 'b'])).toThrow(/multiple connected/);
  });
  it('falls back to the single connected device', () => {
    expect(selectRef(undefined, undefined, undefined, ['only'])).toBe('only');
  });
  it('throws when none specified and zero or many connected', () => {
    expect(() => selectRef(undefined, undefined, undefined, [])).toThrow(/none connected/);
    expect(() => selectRef(undefined, undefined, undefined, ['a', 'b'])).toThrow(/multiple connected/);
  });
});
