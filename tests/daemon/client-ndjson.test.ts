import { describe, it, expect, vi, afterEach } from 'vitest';
import { daemonFetchNdjson } from '../../src/daemon/client.js';

const fakeInfo = { pid: 1, port: 12345 } as any;

function mockFetch(body: string, contentType: string | null = 'application/x-ndjson', status = 200): void {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split the body in half to test multi-chunk decoding
      const half = Math.floor(body.length / 2);
      controller.enqueue(new TextEncoder().encode(body.slice(0, half)));
      controller.enqueue(new TextEncoder().encode(body.slice(half)));
      controller.close();
    },
  });
  globalThis.fetch = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    body: stream,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as any);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('daemonFetchNdjson', () => {
  it('yields one parsed object per NDJSON line, in order, across chunk boundaries', async () => {
    const lines = [
      JSON.stringify({ type: 'started', package: 'com.x' }),
      JSON.stringify({ type: 'installed', installSecs: 1.0 }),
      JSON.stringify({ type: 'done', ok: true, package: 'com.x' }),
    ].join('\n') + '\n';
    mockFetch(lines);

    const out: any[] = [];
    for await (const e of daemonFetchNdjson(fakeInfo, '/deploy', { apk_path: 'x' })) {
      out.push(e);
    }
    expect(out).toEqual([
      { type: 'started', package: 'com.x' },
      { type: 'installed', installSecs: 1.0 },
      { type: 'done', ok: true, package: 'com.x' },
    ]);
  });

  it('yields a single object when the response is plain JSON (validation-error fallback)', async () => {
    mockFetch(JSON.stringify({ ok: false, error: 'apk_path required' }), 'application/json');
    const out: any[] = [];
    for await (const e of daemonFetchNdjson(fakeInfo, '/deploy', {})) {
      out.push(e);
    }
    expect(out).toEqual([{ ok: false, error: 'apk_path required' }]);
  });

  it('yields a final object even when the last NDJSON line lacks a trailing newline', async () => {
    const body = JSON.stringify({ type: 'done', ok: true, package: 'com.x' }); // no \n
    mockFetch(body);
    const out: any[] = [];
    for await (const e of daemonFetchNdjson(fakeInfo, '/deploy', {})) {
      out.push(e);
    }
    expect(out).toEqual([{ type: 'done', ok: true, package: 'com.x' }]);
  });

  it('throws a useful error when the response is neither NDJSON nor JSON', async () => {
    mockFetch('Internal server error', 'text/plain', 500);
    const gen = daemonFetchNdjson(fakeInfo, '/deploy', {});
    await expect(gen.next()).rejects.toThrow(/HTTP 500.*text\/plain.*Internal server error/);
  });

  it('annotates malformed NDJSON lines with the path and a preview', async () => {
    mockFetch('{"type":"started"}\n{not json}\n', 'application/x-ndjson');
    const gen = daemonFetchNdjson(fakeInfo, '/deploy', {});
    await gen.next(); // first line ok
    await expect(gen.next()).rejects.toThrow(/Invalid NDJSON line from \/deploy.*\{not json\}/);
  });
});
