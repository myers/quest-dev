import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendDaemonPing } from '../../src/daemon/client.js';

describe('sendDaemonPing', () => {
  // 15 s test deadline against the child's 2 s self-destruct: the two can no
  // longer race, so a signal that never lands fails as `expected 1 to be 42`
  // rather than as an opaque vitest timeout with no diagnostic.
  it('delivers SIGUSR1 to the daemon process', { timeout: 15000 }, async () => {
    // Stand-in daemon, ordered like the real one (src/daemon/daemon.ts: the
    // SIGUSR1 handler is installed before writeRegistry, so a daemon a client
    // can discover is always a daemon it can signal). Announcing readiness on
    // stdout stands in for writeRegistry. Exits 42 on SIGUSR1, 1 on timeout.
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGUSR1", () => process.exit(42));' +
          'console.log("ready");' +
          'setTimeout(() => process.exit(1), 2000);',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    const exited = new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)));

    // Wait for the readiness line, not a sleep. Racing it against exit turns a
    // child that dies during startup into a named failure instead of a hang.
    await Promise.race([
      once(child.stdout!, 'data'),
      exited.then((c) => {
        throw new Error(`stand-in daemon exited ${c} before signalling ready`);
      }),
    ]);

    sendDaemonPing({ pid: child.pid! });

    expect(await exited).toBe(42);
  });

  // The race this covers: discoverDaemon()'s isPidAlive() passes, then the
  // daemon idles out / hits low battery / is stopped before the signal lands.
  // ESRCH is an ordinary outcome there, not a crash (quest-dev-ping-esrch-stack-trace).
  it('reports a dead PID as "gone" instead of throwing ESRCH', { timeout: 15000 }, async () => {
    const child = spawn(process.execPath, ['-e', 'console.log("ready")'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = new Promise<number>((res) => child.on('exit', (c) => res(c ?? -1)));
    await once(child.stdout!, 'data');
    expect(await exited).toBe(0);

    expect(sendDaemonPing({ pid: child.pid! })).toBe('gone');
  });
});
