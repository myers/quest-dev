import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

/**
 * Minimal extraction of CastManager.broadcast() logic for unit testing
 * without needing to instantiate the full CastManager (which requires ADB).
 */
function broadcast(
  sseClients: Set<ServerResponse>,
  event: string,
  data: unknown,
): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

function makeFakeRes(opts?: { throwOnWrite?: boolean }): ServerResponse {
  return {
    write: opts?.throwOnWrite
      ? () => { throw new Error("socket destroyed"); }
      : vi.fn(),
  } as unknown as ServerResponse;
}

describe("SSE broadcast", () => {
  it("writes to all live clients", () => {
    const clients = new Set<ServerResponse>();
    const a = makeFakeRes();
    const b = makeFakeRes();
    clients.add(a);
    clients.add(b);

    broadcast(clients, "status", { ok: true });

    expect(a.write).toHaveBeenCalledOnce();
    expect(b.write).toHaveBeenCalledOnce();
    expect(clients.size).toBe(2);
  });

  it("removes dead clients on write error", () => {
    const clients = new Set<ServerResponse>();
    const alive = makeFakeRes();
    const dead = makeFakeRes({ throwOnWrite: true });
    clients.add(alive);
    clients.add(dead);

    broadcast(clients, "status", { ok: true });

    expect(alive.write).toHaveBeenCalledOnce();
    expect(clients.size).toBe(1);
    expect(clients.has(alive)).toBe(true);
    expect(clients.has(dead)).toBe(false);
  });

  it("handles all clients dead", () => {
    const clients = new Set<ServerResponse>();
    clients.add(makeFakeRes({ throwOnWrite: true }));
    clients.add(makeFakeRes({ throwOnWrite: true }));

    expect(() => broadcast(clients, "status", {})).not.toThrow();
    expect(clients.size).toBe(0);
  });
});
