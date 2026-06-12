import { describe, it, expect } from 'vitest';
import { selectRef } from '../../src/daemon/resolve.js';

describe('selectRef (precedence)', () => {
  it('prefers explicit cliDevice', () => {
    expect(selectRef('cli', 'env', 'cfg', ['onlyone'])).toBe('cli');
  });
  it('falls back to QUEST_DEVICE env', () => {
    expect(selectRef(undefined, 'env', 'cfg', ['onlyone'])).toBe('env');
  });
  it('falls back to config.device', () => {
    expect(selectRef(undefined, undefined, 'cfg', ['a', 'b'])).toBe('cfg');
  });
  it('falls back to the single connected device', () => {
    expect(selectRef(undefined, undefined, undefined, ['only'])).toBe('only');
  });
  it('throws when none given and zero or many connected', () => {
    expect(() => selectRef(undefined, undefined, undefined, [])).toThrow();
    expect(() => selectRef(undefined, undefined, undefined, ['a', 'b'])).toThrow();
  });
});
