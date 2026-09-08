import { describe, it, expect } from 'vitest';
import { isPortListening, getCDPPort, firstFreePort, cdpForwardPort, resolveCdpPort } from '../src/utils/adb.js';
import { cdpPortForSerial } from '../src/utils/device-id.js';
import net from 'net';

describe('isPortListening', () => {
  it('should return false for a port that is not listening', async () => {
    // Use a high port number unlikely to be in use
    const result = await isPortListening(59999);
    expect(result).toBe(false);
  });

  it('should return true for a port that is listening', async () => {
    // Create a temporary server
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as net.AddressInfo;
    const port = address.port;

    const result = await isPortListening(port);
    expect(result).toBe(true);

    // Clean up
    server.close();
  });
});

describe('getCDPPort', () => {
  it('should return the default CDP port', async () => {
    const port = await getCDPPort();
    expect(port).toBe(9223);
  });
});

describe('firstFreePort', () => {
  it('returns the preferred port when the probe says it is free', async () => {
    const p = await firstFreePort(9230, async () => true);
    expect(p).toBe(9230);
  });
  it('probes upward until a free port is found', async () => {
    const taken = new Set([9230, 9231]);
    const p = await firstFreePort(9230, async (port) => !taken.has(port));
    expect(p).toBe(9232);
  });
});

describe('cdpForwardPort', () => {
  const list = [
    '2G0YC1ZF7V0HP1 tcp:9249 localabstract:chrome_devtools_remote_4083',
    '1WMHHA1234567 tcp:9260 localabstract:chrome_devtools_remote',
  ].join('\n');

  it('finds this device\'s existing CDP forward', () => {
    expect(cdpForwardPort(list, '2G0YC1ZF7V0HP1')).toBe(9249);
  });

  it('does not return another device\'s forward', () => {
    expect(cdpForwardPort(list, 'nosuchserial')).toBeUndefined();
  });

  it('ignores forwards that are not devtools sockets', () => {
    const other = '2G0YC1ZF7V0HP1 tcp:9249 localabstract:something_else';
    expect(cdpForwardPort(other, '2G0YC1ZF7V0HP1')).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(cdpForwardPort('', '2G0YC1ZF7V0HP1')).toBeUndefined();
  });
});

describe('resolveCdpPort', () => {
  // The leak (iss 28f5eb0): adb listens on its own forwarded port, so probing
  // for a free port walks past it and allocates a new forward every call.
  it('reuses the existing forward instead of probing past it', async () => {
    const listed = '2G0YC1ZF7V0HP1 tcp:9249 localabstract:chrome_devtools_remote_4083';
    const port = await resolveCdpPort(
      '2G0YC1ZF7V0HP1',
      async (p) => p !== 9249, // 9249 "in use" — adb is listening on it
      async () => listed,
    );
    expect(port).toBe(9249);
  });

  it('probes from the preferred port when the device has no forward yet', async () => {
    const port = await resolveCdpPort('2G0YC1ZF7V0HP1', async () => true, async () => '');
    expect(port).toBe(cdpPortForSerial('2G0YC1ZF7V0HP1'));
  });

  it('falls back to probing when adb forward --list fails', async () => {
    const port = await resolveCdpPort(
      '2G0YC1ZF7V0HP1',
      async () => true,
      async () => { throw new Error('adb: device offline'); },
    );
    expect(port).toBe(cdpPortForSerial('2G0YC1ZF7V0HP1'));
  });
});
