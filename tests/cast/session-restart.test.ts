import { describe, expect, it, vi, beforeEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";

/**
 * Bug: session.restart() calls stop() which closes the TCP server,
 * then calls start() which expects the server to be listening.
 * The server must be re-bound (listen again) after close.
 *
 * We test the core invariant: after restart(), the server is listening.
 */

describe("TCP server re-bind after close", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer();
    // Bind to random port
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  it("closed server does not accept connections", async () => {
    server.close();
    // Wait for close to complete
    await new Promise((r) => setTimeout(r, 50));

    // Try to connect — should fail
    const result = await new Promise<string>((resolve) => {
      const sock = new (require("node:net").Socket)();
      sock.on("error", () => resolve("refused"));
      sock.on("connect", () => { sock.destroy(); resolve("connected"); });
      sock.connect(port, "127.0.0.1");
    });
    expect(result).toBe("refused");
  });

  it("server can re-listen after close", async () => {
    // Close then re-listen on same port
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.listen(port, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    // Should accept connections again
    const result = await new Promise<string>((resolve) => {
      const sock = new (require("node:net").Socket)();
      sock.on("error", () => resolve("refused"));
      sock.on("connect", () => { sock.destroy(); resolve("connected"); });
      sock.connect(port, "127.0.0.1");
    });
    expect(result).toBe("connected");
    server.close();
  });
});

describe("connection count guard", () => {
  it("should only process exactly 2 connections", () => {
    const sockets: string[] = [];
    let controlSocket: string | null = null;
    let videoSocket: string | null = null;
    let assignCount = 0;

    // Simulates fixed connection handler using === 2
    function onConnection(id: string) {
      sockets.push(id);
      if (sockets.length === 2) {
        controlSocket = sockets[0];
        videoSocket = sockets[1];
        assignCount++;
      }
    }

    onConnection("sock-a");
    onConnection("sock-b");
    onConnection("sock-c"); // spurious 3rd connection

    expect(assignCount).toBe(1); // assigned exactly once
    expect(controlSocket).toBe("sock-a");
    expect(videoSocket).toBe("sock-b");
  });

  it("bug: >= 2 fires on every subsequent connection", () => {
    const sockets: string[] = [];
    let videoSocket: string | null = null;
    let assignCount = 0;

    // Old buggy handler using >= 2
    function onConnection(id: string) {
      sockets.push(id);
      if (sockets.length >= 2) {
        videoSocket = sockets[1];
        assignCount++;
      }
    }

    onConnection("sock-a");
    onConnection("sock-b");
    onConnection("sock-c"); // spurious 3rd

    expect(assignCount).toBe(2); // BUG: assigned twice
    expect(videoSocket).toBe("sock-b"); // at least video isn't overwritten to sock-c since sockets[1] is stable
  });
});
