import { describe, it, expect } from 'vitest';
import { isPortListening, getCDPPort, firstFreePort } from '../src/utils/adb.js';
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
