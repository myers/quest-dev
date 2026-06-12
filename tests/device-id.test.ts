import { describe, it, expect } from 'vitest';
import { cdpPortForSerial, CDP_PORT_BASE, CDP_PORT_SPAN } from '../src/utils/device-id.js';

describe('cdpPortForSerial', () => {
  it('is deterministic for a given serial', () => {
    expect(cdpPortForSerial('1WMHHA1234567')).toBe(cdpPortForSerial('1WMHHA1234567'));
  });

  it('stays within [BASE, BASE+SPAN)', () => {
    for (const s of ['1WMHHA1234567', '192.168.1.50:5555', 'quest3.home.arap:5555', 'abc', '']) {
      const p = cdpPortForSerial(s);
      expect(p).toBeGreaterThanOrEqual(CDP_PORT_BASE);
      expect(p).toBeLessThan(CDP_PORT_BASE + CDP_PORT_SPAN);
    }
  });

  it('uses 9223 as the base and a 64-wide span', () => {
    expect(CDP_PORT_BASE).toBe(9223);
    expect(CDP_PORT_SPAN).toBe(64);
  });

  it('produces different ports for at least some different serials', () => {
    const a = cdpPortForSerial('serialA');
    const b = cdpPortForSerial('serialB');
    const c = cdpPortForSerial('serialC');
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });
});
