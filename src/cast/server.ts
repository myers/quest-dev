/**
 * Fastify HTTP server for the cast command.
 *
 * Serves REST API endpoints for screenshots, pose control, configuration,
 * and MJPEG streaming. Also serves the static frontend dashboard.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { join, dirname } from "node:path";
import { EYE_LEFT, EYE_RIGHT, EYE_STEREO } from "./protocol/mud.js";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { type CastSession } from "./session.js";
import { verbose } from "../utils/verbose.js";
import { execCommand } from "../utils/exec.js";
import { screenToYawPitch } from "./pose.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CastServerOptions {
  port: number;
  session: CastSession;
  onActivity?: () => void;
}

export async function createCastServer(
  options: CastServerOptions,
): Promise<FastifyInstance> {
  const { port, session, onActivity } = options;

  const app = Fastify({ logger: false });

  // Activity tracking: reset idle timer on every request
  if (onActivity) {
    app.addHook("onRequest", async () => {
      onActivity();
    });
  }

  // Static file serving for dashboard
  const publicDir = join(__dirname, "..", "public");
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    decorateReply: false,
  });

  // --- SSE broadcast ---
  const sseClients = new Set<ServerResponse>();

  function broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(msg);
    }
  }

  // Wire up session events to SSE
  session.on("connected", () => broadcast("state", { connected: true, running: true }));
  session.on("disconnected", () => broadcast("state", { connected: false, running: false, pose_loop: false }));
  session.on("pose-loop", (active: boolean) => broadcast("state", { pose_loop: active }));

  app.get("/events", async (_req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    // Send current state immediately
    const init = {
      connected: session.connected,
      running: session.running,
      pose_loop: session.poseLoopActive,
    };
    reply.raw.write(`event: state\ndata: ${JSON.stringify(init)}\n\n`);
    sseClients.add(reply.raw);
    _req.raw.on("close", () => sseClients.delete(reply.raw));
  });

  // Helper to broadcast a toast to all dashboard clients
  function broadcastToast(msg: string): void {
    broadcast("toast", { message: msg });
  }

  // --- GET endpoints ---

  app.get("/help", async (_req, reply) => {
    const help = `quest-dev cast — REST API

GET endpoints
  /help                 This help screen
  /screenshot           Latest frame as JPEG (503 if no frame)
  /stream               MJPEG stream (multipart/x-mixed-replace)
  /status               JSON: connected, running, resolution, fps, frame_count, pose
  /layers               JSON: available layers and active layer ID
  /events               SSE stream: state changes and toast notifications

POST endpoints (JSON body)
  /config               Set resolution
                          { width: 2064, height: 1162 }
  /eye                  Set eye mode
                          { mode: "left" | "right" | "stereo" }
  /pose                 Set or nudge camera pose
                          Absolute: { x, y, z, yaw, pitch }
                          Delta:    { dx, dy, dz, d_yaw, d_pitch }
  /pose-loop            Toggle periodic pose refresh (~27 Hz)
                          { active: true | false }   (omit to toggle)
  /rotate               Rotate camera (deprecated, use /pose)
                          { pitch, yaw }
  /move                 Move + rotate (deprecated, use /pose)
                          { forward, strafe, yaw, pitch }
  /click                Tap at normalised screen coordinates
                          { x: 0.5, y: 0.5, layer, hold_ms: 50 }
  /gaze                 Gaze-based interaction
                          { action: "enable" }
                          { action: "click", yaw, pitch, dwell_ms: 1200 }
  /mud                  Send raw MUD payload
                          { type: 0, payload_hex: "..." }
  /home                 Press the Home button (ADB keyevent)
  /reset-view           Reset camera to default pose, stop pose loop
  /restart              Restart the cast session
  /stop                 Stop casting
`;
    return reply.type("text/plain").send(help);
  });

  app.get("/screenshot", async (_req, reply) => {
    const jpeg = session.getScreenshot();
    if (jpeg) {
      return reply.type("image/jpeg").send(jpeg);
    }
    return reply.code(503).send({ error: "no frame available" });
  });

  app.get("/stream", async (_req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache",
      "Connection": "close",
    });

    const interval = setInterval(() => {
      if (!session.running) {
        clearInterval(interval);
        reply.raw.end();
        return;
      }
      const jpeg = session.getScreenshot();
      if (jpeg) {
        reply.raw.write(
          `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
        );
        reply.raw.write(jpeg);
        reply.raw.write("\r\n");
      }
    }, 200);

    _req.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  app.get("/status", async () => {
    return {
      connected: session.connected,
      running: session.running,
      width: session.width,
      height: session.height,
      frame_count: session.frameCount,
      bytes: session.byteCount,
      fps: session.fps,
      elapsed: session.running ? Math.round((Date.now() - Date.now()) / 100) / 10 : 0,
      has_frame: session.getScreenshot() !== null,
      pose_loop: session.poseLoopActive,
      pose: {
        x: round4(session.pose.x),
        y: round4(session.pose.y),
        z: round4(session.pose.z),
        yaw: round4(session.pose.yaw),
        pitch: round4(session.pose.pitch),
        yaw_deg: round1(deg(session.pose.yaw)),
        pitch_deg: round1(deg(session.pose.pitch)),
      },
    };
  });

  app.get("/layers", async () => {
    const layers: Record<string, unknown> = {};
    for (const [id, info] of session.layers) {
      layers[String(id)] = info;
    }
    return { layers, active_layer_id: session.layerId };
  });

  // --- POST endpoints ---

  app.post<{ Body: { pitch?: number; yaw?: number } }>("/rotate", async (req) => {
    if (!session.connected) return { error: "not connected" };
    const { pitch = 0, yaw = 0 } = req.body ?? {};
    session.sendRotation(pitch, yaw);
    return { ok: true, pitch, yaw };
  });

  app.post<{ Body: { forward?: number; strafe?: number; yaw?: number; pitch?: number } }>(
    "/move",
    async (req) => {
      if (!session.connected) return { error: "not connected" };
      const { forward = 0, strafe = 0, yaw = 0, pitch = 0 } = req.body ?? {};
      session.sendRotation(pitch, yaw, forward, strafe);
      return { ok: true };
    },
  );

  app.post<{ Body: { width?: number; height?: number } }>("/config", async (req) => {
    if (!session.connected) return { error: "not connected" };
    const width = req.body?.width ?? session.width;
    const height = req.body?.height ?? session.height;
    session.sendDisplayConfig(width, height);
    broadcastToast(`Resolution: ${width}\u00d7${height}`);
    return { ok: true, width, height };
  });

  app.post<{ Body: { mode?: string } }>("/eye", async (req) => {
    if (!session.connected) return { error: "not connected" };
    const mode = req.body?.mode ?? "left";
    const eyeMap: Record<string, number> = {
      left: EYE_LEFT,
      right: EYE_RIGHT,
      stereo: EYE_STEREO,
      both: EYE_STEREO,
    };
    const eye = eyeMap[mode] ?? EYE_LEFT;
    session.sendDisplayConfig(session.width, session.height, eye);
    broadcastToast(`Eye mode: ${mode}`);
    return { ok: true, mode };
  });

  app.post<{ Body: { x?: number; y?: number; layer?: number; hold_ms?: number } }>(
    "/click",
    async (req) => {
      if (!session.connected) return { error: "not connected" };
      const { x = 0.5, y = 0.5, layer, hold_ms = 50 } = req.body ?? {};
      await session.sendClick(x, y, layer, hold_ms);
      const layerInfo = session.layers.get(layer ?? session.layerId);
      return {
        ok: true,
        x,
        y,
        layer: layer ?? session.layerId,
        layer_name: layerInfo?.layer ?? "",
      };
    },
  );

  app.post<{
    Body: {
      x?: number; y?: number; z?: number; yaw?: number; pitch?: number;
      dx?: number; dy?: number; dz?: number; d_yaw?: number; d_pitch?: number;
    };
  }>("/pose", async (req) => {
    if (!session.connected) return { error: "not connected" };
    const data = req.body ?? {};

    // Absolute pose set
    if ("x" in data || "y" in data || "z" in data || "yaw" in data || "pitch" in data) {
      session.setPoseAbsolute({
        x: data.x, y: data.y, z: data.z,
        yaw: data.yaw, pitch: data.pitch,
      });
    }
    // Incremental deltas
    if ("dx" in data || "dy" in data || "dz" in data || "d_yaw" in data || "d_pitch" in data) {
      session.applyPoseDelta({
        dForward: data.dz ?? 0,
        dStrafe: data.dx ?? 0,
        dUp: data.dy ?? 0,
        dYaw: data.d_yaw ?? 0,
        dPitch: data.d_pitch ?? 0,
      });
    }

    const p = session.pose;
    return {
      ok: true,
      x: round4(p.x), y: round4(p.y), z: round4(p.z),
      yaw: round4(p.yaw), pitch: round4(p.pitch),
      qw: round4(p.qw), qx: round4(p.qx), qy: round4(p.qy), qz: round4(p.qz),
    };
  });

  app.post<{ Body: { action?: string; yaw?: number; pitch?: number; dwell_ms?: number } }>(
    "/gaze",
    async (req) => {
      if (!session.connected) return { error: "not connected" };
      const data = req.body ?? {};
      const action = data.action ?? "enable";

      if (action === "enable") {
        session.ensureInputForwarding();
        return { ok: true, action: "enable" };
      }

      if (action === "click") {
        session.ensureInputForwarding();
        const yaw = data.yaw ?? session.pose.yaw;
        const pitch = data.pitch ?? session.pose.pitch;
        const dwellMs = data.dwell_ms ?? 1200;

        session.setPoseAbsolute({ yaw, pitch });
        const steps = Math.floor(dwellMs / 16);
        for (let i = 0; i < steps; i++) {
          session.sendPose(session.pose);
          await new Promise((r) => setTimeout(r, 16));
        }

        return { ok: true, action: "click", yaw: round4(yaw), pitch: round4(pitch), dwell_ms: dwellMs };
      }

      return { error: `unknown action: ${action}` };
    },
  );

  app.post<{ Body: { active?: boolean } }>("/pose-loop", async (req) => {
    const active = req.body?.active ?? !session.poseLoopActive;
    if (active) {
      session.startPoseLoop();
    } else {
      session.stopPoseLoop();
    }
    return { ok: true, pose_loop: session.poseLoopActive };
  });

  app.post("/stop", async () => {
    if (!session.connected) return { error: "not connected" };
    await session.stop();
    broadcastToast("Casting stopped");
    return { ok: true };
  });

  app.post("/restart", async () => {
    broadcastToast("Restarting cast\u2026");
    session.restart().catch((err) => verbose("Restart error:", err));
    return { ok: true, msg: "restarting cast session" };
  });

  app.post("/reset-view", async () => {
    if (!session.connected) return { error: "not connected" };
    session.resetView();
    broadcastToast("View reset");
    broadcast("state", { pose_loop: false });
    return { ok: true, mode: "normal" };
  });

  app.post("/home", async () => {
    try {
      await execCommand("adb", ["shell", "input", "keyevent", "KEYCODE_HOME"]);
      broadcastToast("Home");
      return { ok: true };
    } catch {
      return { error: "failed to send home key" };
    }
  });

  app.post<{ Body: { type?: number; payload_hex?: string } }>("/mud", async (req) => {
    if (!session.connected) return { error: "not connected" };
    const typeId = req.body?.type ?? 0;
    const payloadHex = req.body?.payload_hex ?? "";
    const payload = payloadHex ? Buffer.from(payloadHex, "hex") : undefined;
    session.sendMud(typeId, payload);
    return { ok: true, type: typeId, payload_len: payload?.length ?? 0 };
  });

  await app.listen({ port, host: "0.0.0.0" });
  return app;
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
