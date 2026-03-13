/**
 * CastManager: lazy-loaded manager for cast sessions within the daemon.
 * Wraps CastSession with start/stop lifecycle and SSE broadcasting.
 */

import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { checkADBPath } from "../utils/adb.js";
import { execCommand } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import { CastSession } from "../cast/session.js";

export interface CastStartOptions {
  listenPort?: number;
  width?: number;
  height?: number;
}

export class CastManager extends EventEmitter {
  private session: CastSession | null = null;
  private sseClients = new Set<ServerResponse>();
  private questIp: string | null = null;

  get isActive(): boolean {
    return this.session !== null && this.session.connected;
  }

  getSession(): CastSession | null {
    return this.session;
  }

  async start(opts: CastStartOptions = {}): Promise<void> {
    if (this.session?.connected) {
      return; // Already active
    }

    // Stop any lingering session
    if (this.session) {
      await this.stopSession();
    }

    checkADBPath();

    // Check for connected devices
    const output = await execCommand("adb", ["devices"]);
    const lines = output.trim().split("\n").slice(1);
    const devices = lines.filter(
      (line) => line.trim() && !line.includes("List of devices"),
    );
    if (devices.length === 0) {
      throw new Error("No ADB devices connected");
    }

    // Get Quest IP
    const questIp = await this.getQuestIp();
    this.questIp = questIp;

    const listenPort = opts.listenPort ?? 4445;
    const width = opts.width ?? 2064;
    const height = opts.height ?? 1162;

    // Create and start session
    const session = new CastSession({ listenPort, width, height });
    this.session = session;

    // Wire session events → SSE broadcast
    session.on("connected", () =>
      this.broadcast("state", { connected: true, running: true }),
    );
    session.on("disconnected", () => {
      this.broadcast("state", {
        connected: false,
        running: false,
        pose_loop: false,
      });
    });
    session.on("pose-loop", (active: boolean) =>
      this.broadcast("state", { pose_loop: active }),
    );

    await session.bind();
    if (session.listenPort !== listenPort) {
      verbose(
        `Port ${listenPort} in use, listening on ${session.listenPort}`,
      );
    }
    await session.adbSetup(questIp);
    await session.start(questIp);
    verbose("Quest connected, casting active");
  }

  async stop(): Promise<void> {
    await this.stopSession();
    this.broadcast("state", {
      connected: false,
      running: false,
      pose_loop: false,
    });
  }

  async restart(): Promise<void> {
    if (!this.session) {
      // No session to restart — start fresh
      await this.start();
      return;
    }
    this.broadcastToast("Restarting cast\u2026");
    await this.session.restart();
  }

  private async stopSession(): Promise<void> {
    if (this.session) {
      try {
        await this.session.stop();
      } catch {
        // Best effort
      }
      this.session = null;
    }
  }

  private async getQuestIp(): Promise<string> {
    const devOutput = await execCommand("adb", ["devices"]);
    const devLines = devOutput.trim().split("\n").slice(1);
    const firstDevice = devLines.find((l) => l.includes("device"));
    if (!firstDevice) {
      throw new Error("No authorized ADB device found");
    }
    const deviceId = firstDevice.split("\t")[0].trim();
    try {
      const ip = await execCommand("adb", [
        "-s",
        deviceId,
        "shell",
        "ip addr show wlan0 | grep 'inet ' | tr -s ' ' | cut -f3 -d' ' | cut -f1 -d/",
      ]);
      const trimmed = ip.trim();
      if (trimmed && !trimmed.includes("error")) {
        return trimmed;
      }
    } catch {
      // Fallback
    }
    return deviceId.split(":")[0];
  }

  // --- SSE ---

  broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      res.write(msg);
    }
  }

  broadcastToast(msg: string): void {
    this.broadcast("toast", { message: msg });
  }

  addSSEClient(res: ServerResponse): void {
    this.sseClients.add(res);
  }

  removeSSEClient(res: ServerResponse): void {
    this.sseClients.delete(res);
  }

  // --- Cleanup ---

  cleanup(): void {
    if (this.session) {
      try {
        this.session.stop();
      } catch {
        // Best effort sync cleanup
      }
      this.session = null;
    }
    // Close all SSE connections
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        // Ignore
      }
    }
    this.sseClients.clear();
  }
}
