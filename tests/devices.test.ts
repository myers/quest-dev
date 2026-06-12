import { describe, it, expect } from 'vitest';
import { setAlias, removeAlias, lookupRef, type DeviceMap } from '../src/utils/devices.js';

describe('setAlias', () => {
  it('adds a new alias with address and serial', () => {
    const map: DeviceMap = {};
    const next = setAlias(map, 'quest3', '127.0.0.1:5555', '1WMHHA1234567');
    expect(next).toEqual({ quest3: { address: '127.0.0.1:5555', serial: '1WMHHA1234567' } });
  });

  it('updates an existing alias address in place (alias follows the device)', () => {
    const map: DeviceMap = { quest3: { address: '127.0.0.1:5555', serial: '1WMHHA1234567' } };
    const next = setAlias(map, 'quest3', 'quest3.home.arap:5555', '1WMHHA1234567');
    expect(next.quest3.address).toBe('quest3.home.arap:5555');
    expect(next.quest3.serial).toBe('1WMHHA1234567');
  });

  it('refreshes the serial when the alias is pointed at a different physical device', () => {
    const map: DeviceMap = { quest3: { address: '127.0.0.1:5555', serial: 'OLDSERIAL' } };
    const next = setAlias(map, 'quest3', '10.0.0.9:5555', 'NEWSERIAL');
    expect(next.quest3.serial).toBe('NEWSERIAL');
  });

  it('does not mutate the input map', () => {
    const map: DeviceMap = {};
    setAlias(map, 'q', 'a', 's');
    expect(map).toEqual({});
  });
});

describe('removeAlias', () => {
  it('removes an alias', () => {
    const map: DeviceMap = { quest3: { address: 'a', serial: 's' } };
    expect(removeAlias(map, 'quest3')).toEqual({});
  });
  it('is a no-op for an unknown alias', () => {
    const map: DeviceMap = { quest3: { address: 'a', serial: 's' } };
    expect(removeAlias(map, 'nope')).toEqual(map);
  });
});

describe('lookupRef', () => {
  const map: DeviceMap = { quest3: { address: 'quest3.home.arap:5555', serial: '1WMHHA1234567' } };

  it('resolves an alias to its stored address', () => {
    expect(lookupRef(map, 'quest3')).toEqual({ address: 'quest3.home.arap:5555', alias: 'quest3' });
  });

  it('treats an unknown ref as a raw address', () => {
    expect(lookupRef(map, '127.0.0.1:5555')).toEqual({ address: '127.0.0.1:5555', alias: undefined });
  });
});
