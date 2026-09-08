import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as deployMod from '../../src/daemon/deploy.js';
import * as configMod from '../../src/utils/config.js';
import * as adbMod from '../../src/utils/adb.js';

// We boot a tiny Fastify app that registers ONLY the /deploy route, so we can
// assert the wire format without needing the full daemon.
async function makeApp(opts?: { pin?: string | null }): Promise<FastifyInstance> {
  const pinValue = opts?.pin === undefined ? '1234' : opts.pin;
  vi.spyOn(configMod, 'tryLoadPin').mockReturnValue(pinValue);

  const app = Fastify({ logger: false });
  const stayAwake = { isEnabled: true, turnOn: vi.fn().mockResolvedValue(undefined) } as any;
  const logcat = {
    start: vi.fn(),
    status: () => ({ file: '/tmp/fake.log' }),
    scanForCrash: () => ({ crashed: false, lines: [] }),
    readTail: () => [],
  } as any;

  // Re-implement the route using the same handler shape as server.ts.
  app.post<{ Body: { apk_path?: string; crash_wait_ms?: number } }>(
    '/deploy',
    async (req, reply) => {
      const { apk_path, crash_wait_ms } = req.body ?? {};
      if (!apk_path) {
        reply.code(400);
        return { ok: false, error: 'apk_path required' };
      }
      const pin = configMod.tryLoadPin();
      if (pin === null) {
        reply.code(400);
        return {
          ok: false,
          error:
            'PIN required for deploy. Stay-awake must be enabled to prevent ' +
            'the Quest from sleeping mid-install. Save it with: ' +
            'quest-dev config --pin <pin>',
        };
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      });
      const writeEvent = (e: deployMod.DeployEvent) => {
        try { reply.raw.write(JSON.stringify(e) + '\n'); } catch { /* socket gone */ }
      };
      try {
        await deployMod.deploy(
          { apkPath: apk_path, pin, crashWaitMs: crash_wait_ms, onEvent: writeEvent },
          stayAwake,
          logcat,
        );
      } catch (err) {
        writeEvent({ type: 'done', ok: false, package: '', crashed: false, error: String(err) });
      } finally {
        try { reply.raw.end(); } catch { /* ignore */ }
      }
      return reply;
    },
  );
  return app;
}

describe('POST /deploy', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    // Default to healthy ADB so tests don't shell out to real adb.
    vi.spyOn(adbMod, 'ensureAdbHealthy').mockResolvedValue({ kind: 'healthy' });
    app = await makeApp();
  });

  it('returns NDJSON with a terminal done event when the APK does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/deploy',
      payload: { apk_path: '/definitely/does/not/exist.apk' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({
      type: 'done',
      ok: false,
      crashed: false,
      error: expect.stringContaining('APK not found'),
    });
  });

  it('returns JSON 400 when apk_path is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/deploy',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: 'apk_path required' });
  });

  it('returns JSON 400 when no PIN is configured', async () => {
    app = await makeApp({ pin: null });
    const res = await app.inject({
      method: 'POST',
      url: '/deploy',
      payload: { apk_path: '/some/path.apk' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('PIN required');
    expect(body.error).toContain('quest-dev config --pin');
  });
});
