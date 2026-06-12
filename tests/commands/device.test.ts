import { describe, it, expect } from 'vitest';
import { buildDeviceInfo } from '../../src/commands/device.js';

describe('buildDeviceInfo', () => {
  it('reports ports from a live daemon record', () => {
    const info = buildDeviceInfo(
      { address: '127.0.0.1:5555', serial: 'S1', alias: 'quest3' },
      { pid: 9, port: 40001, serial: 'S1', address: '127.0.0.1:5555', cdpPort: 9230, castPort: 41001, startedAt: 't' },
      { level: 80, state: 'charging' },
    );
    expect(info).toMatchObject({
      alias: 'quest3', serial: 'S1', address: '127.0.0.1:5555',
      daemonPort: 40001, cdpPort: 9230, castPort: 41001,
      stayAwake: true, battery: '80% charging',
    });
  });

  it('reports null ports and stayAwake=false when no daemon is running', () => {
    const info = buildDeviceInfo(
      { address: '127.0.0.1:5555', serial: 'S1', alias: undefined },
      null,
      null,
    );
    expect(info).toMatchObject({
      serial: 'S1', daemonPort: null, cdpPort: null, castPort: null, stayAwake: false, battery: null,
    });
  });
});
