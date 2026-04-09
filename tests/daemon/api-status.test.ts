import { describe, expect, it, vi } from "vitest";

/**
 * Bug: Dashboard api() helper doesn't check HTTP status codes.
 * A 500 response with HTML body would throw an uncaught JSON parse error.
 * Fix: check response.ok before parsing JSON.
 */

/** Fixed api helper that checks HTTP status. */
async function apiFetch(
  fetcher: typeof fetch,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const opts: RequestInit = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const r = await fetcher(path, opts);
  if (!r.ok) {
    // Try to parse JSON error, fall back to status text
    let msg: string;
    try {
      const json = await r.json();
      msg = json.error ?? r.statusText;
    } catch {
      msg = r.statusText;
    }
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return r.json();
}

function mockFetch(status: number, body: unknown, contentType = "application/json"): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 500 ? "Internal Server Error" : "OK",
    json: () => Promise.resolve(body),
    headers: new Headers({ "content-type": contentType }),
  }) as unknown as typeof fetch;
}

describe("api fetch with status checking", () => {
  it("returns JSON on 200", async () => {
    const f = mockFetch(200, { ok: true });
    const result = await apiFetch(f, "GET", "/status");
    expect(result).toEqual({ ok: true });
  });

  it("throws on 500 with JSON error body", async () => {
    const f = mockFetch(500, { error: "something broke" });
    await expect(apiFetch(f, "POST", "/cast/start")).rejects.toThrow(
      "HTTP 500: something broke",
    );
  });

  it("throws on 503 with fallback to statusText", async () => {
    const f = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () => Promise.reject(new Error("not json")),
    }) as unknown as typeof fetch;

    await expect(apiFetch(f, "GET", "/cast/screenshot")).rejects.toThrow(
      "HTTP 503: Service Unavailable",
    );
  });

  it("passes body correctly", async () => {
    const f = mockFetch(200, { ok: true });
    await apiFetch(f, "POST", "/cast/pose", { dz: 0.3 });
    expect(f).toHaveBeenCalledWith("/cast/pose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"dz":0.3}',
    });
  });
});
