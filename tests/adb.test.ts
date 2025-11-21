import { describe, it, expect } from 'vitest';
import { isPortListening, getCDPPort } from '../src/utils/adb.js';
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
  it('should return the default CDP port', () => {
    const port = getCDPPort();
    expect(port).toBe(9223);
  });
});
