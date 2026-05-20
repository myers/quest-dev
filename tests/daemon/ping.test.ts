import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { sendDaemonPing } from '../../src/daemon/client.js';

describe('sendDaemonPing', () => {
  it('delivers SIGUSR1 to the daemon process', async () => {
    // Stand-in daemon: exits 42 on SIGUSR1, exits 1 if it times out first.
    const child = spawn('node', [
      '-e',
      'process.on("SIGUSR1", () => process.exit(42)); setTimeout(() => process.exit(1), 5000);',
    ]);
    // Give the child a moment to install its signal handler.
    await new Promise((r) => setTimeout(r, 400));

    sendDaemonPing({ pid: child.pid!, port: 0, startedAt: '' });

    const code = await new Promise<number>((res) =>
      child.on('exit', (c) => res(c ?? -1)),
    );
    expect(code).toBe(42);
  });
});
