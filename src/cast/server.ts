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
import { type CastSession } from "./session.js";
import { verbose } from "../utils/verbose.js";
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

  // --- GET endpoints ---

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

  app.post("/stop", async () => {
    if (!session.connected) return { error: "not connected" };
    await session.stop();
    return { ok: true };
  });

  app.post("/restart", async () => {
    // Fire and forget restart
    session.restart().catch((err) => verbose("Restart error:", err));
    return { ok: true, msg: "restarting cast session" };
  });

  app.post("/reset-view", async () => {
    if (!session.connected) return { error: "not connected" };
    session.resetView();
    return { ok: true, mode: "normal" };
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
