/**
 * CastManager: lazy-loaded manager for cast sessions within the daemon.
 * Wraps CastSession with start/stop lifecycle and SSE broadcasting.
 * Server state is the single source of truth — pushed to clients via SSE.
 */

import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { checkADBPath, getAdbDevice } from "../utils/adb.js";
import { execCommand } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import { CastSession } from "../cast/session.js";
import { ensureCastingInstalled } from "../utils/casting-apk.js";
import { resolveResolution } from "@myerscarpenter/cast2-protocol";

export interface CastStartOptions {
  listenPort?: number;
  resolution?: string;
  width?: number;
  height?: number;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export class CastManager extends EventEmitter {
  private session: CastSession | null = null;
  private sseClients = new Set<ServerResponse>();
  private questIp: string | null = null;
  private configuredDevice: string | undefined;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private starting = false;

  constructor(device?: string) {
    super();
    this.configuredDevice = device;
  }

  get isActive(): boolean {
    return this.session !== null && this.session.connected;
  }

  getSession(): CastSession | null {
    return this.session;
  }

  /** Build full status snapshot from current session state. */
  getStatus(): Record<string, unknown> {
    const session = this.session;
    if (!session) {
      return { connected: false, running: false };
    }
    const p = session.pose;
    return {
      connected: session.connected,
      running: session.running,
      width: session.width,
      height: session.height,
      frame_count: session.frameCount,
      bytes: session.byteCount,
      fps: session.fps,
      elapsed: session.elapsedSeconds,
      has_frame: session.getScreenshot() !== null,
      eye: session.eye === 0 ? "right" : session.eye === 2 ? "stereo" : "left",
      pose_loop: session.poseLoopActive,
      pose: {
        x: round4(p.x),
        y: round4(p.y),
        z: round4(p.z),
        yaw: round4(p.yaw),
        pitch: round4(p.pitch),
        yaw_deg: round1(deg(p.yaw)),
        pitch_deg: round1(deg(p.pitch)),
      },
    };
  }

  async start(opts: CastStartOptions = {}): Promise<void> {
    if (this.session?.connected) {
      return; // Already active
    }
    if (this.starting) {
      throw new Error("Cast start already in progress");
    }
    this.starting = true;

    try {
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

      // Ensure casting service APK is installed on Quest
      // Use the ADB device serial (USB or configured), not the WiFi IP
      const adbDevice = getAdbDevice() ?? await this.getAdbSerial() ?? `${questIp}:5555`;
      await ensureCastingInstalled(adbDevice);

      const listenPort = opts.listenPort ?? 4445;
      const { width, height } = resolveResolution(opts.resolution, opts.width, opts.height);

      // Create and start session
      const session = new CastSession({ listenPort, width, height });
      this.session = session;

      // Wire session events → SSE broadcast
      session.on("connected", () => this.broadcastStatus());
      session.on("disconnected", () => this.broadcastStatus());
      session.on("pose-loop", () => this.broadcastStatus());

      // Complete all async setup before starting periodic work
      await session.bind();
      if (session.listenPort !== listenPort) {
        verbose(
          `Port ${listenPort} in use, listening on ${session.listenPort}`,
        );
      }
      await session.adbSetup(adbDevice);
      await session.start(adbDevice);

      // Stats interval created AFTER all async ops succeed
      this.statsInterval = setInterval(() => {
        if (session.connected) {
          this.broadcastStatus();
        }
      }, 500);

      verbose("Quest connected, casting active");
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    await this.stopSession();
    this.broadcastStatus();
  }

  async restart(): Promise<void> {
    if (!this.session) {
      await this.start();
      return;
    }
    this.broadcastToast("Restarting cast\u2026");
    await this.session.restart();
  }

  private async stopSession(): Promise<void> {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this.session) {
      try {
        await this.session.stop();
      } catch {
        // Best effort
      }
      this.session = null;
    }
  }

  /** Get the first connected ADB device serial (e.g. USB serial or IP:port) */
  private async getAdbSerial(): Promise<string | null> {
    const output = await execCommand("adb", ["devices"]);
    const lines = output.trim().split("\n").slice(1);
    const first = lines.find((l) => l.includes("device"));
    if (!first) return null;
    return first.split("\t")[0].trim();
  }

  private async getQuestIp(): Promise<string> {
    // If a device IP was configured, use it directly (strip :port if present)
    if (this.configuredDevice) {
      const ip = this.configuredDevice.split(":")[0];
      verbose(`Using configured device: ${ip}`);
      return ip;
    }

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
      try {
        res.write(msg);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  /** Broadcast full status snapshot as SSE "status" event. */
  broadcastStatus(): void {
    this.broadcast("status", this.getStatus());
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
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this.session) {
      try {
        this.session.stop();
      } catch {
        // Best effort sync cleanup
      }
      this.session = null;
    }
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
