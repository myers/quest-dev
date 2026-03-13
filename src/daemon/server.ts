/**
 * Unified Fastify server for the quest-dev daemon.
 * Hosts all endpoint groups: core, stay-awake, logcat, deploy, cast.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPin, loadConfig } from "../utils/config.js";
import { getBatteryInfo } from "../utils/adb.js";
import { execCommand } from "../utils/exec.js";
import { EYE_LEFT, EYE_RIGHT, EYE_STEREO } from "../cast/protocol/mud.js";
import type { StayAwakeManager } from "./stay-awake-manager.js";
import type { LogcatManager } from "./logcat-manager.js";
import type { CastManager } from "./cast-manager.js";
import { deploy, type DeployResult } from "./deploy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DaemonServerOptions {
  port: number;
  stayAwake: StayAwakeManager;
  logcat: LogcatManager;
  castManager: CastManager;
  onActivity: () => void;
  onShutdown: () => void;
}

export async function createDaemonServer(
  options: DaemonServerOptions,
): Promise<FastifyInstance> {
  const { port, stayAwake, logcat, castManager, onActivity, onShutdown } =
    options;
  const config = loadConfig();

  const app = Fastify({ logger: false });

  // Static file serving for dashboard
  const publicDir = join(__dirname, "..", "public");
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    decorateReply: false,
  });

  // Activity tracking: reset idle timer on every request
  app.addHook("onRequest", async () => {
    onActivity();
  });

  // --- Core endpoints ---

  app.get("/status", async () => {
    let battery = null;
    try {
      const info = await getBatteryInfo();
      battery = { level: info.level, state: info.state };
    } catch {
      // Device might be unavailable
    }

    const logcatStatus = logcat.status();

    return {
      uptime: Math.round(process.uptime()),
      pid: process.pid,
      stay_awake: stayAwake.isEnabled,
      cast: { active: castManager.isActive },
      logcat: {
        capturing: logcatStatus.capturing,
        file: logcatStatus.file,
        size: logcatStatus.size,
        lines: logcatStatus.lines,
      },
      battery,
    };
  });

  app.post("/shutdown", async () => {
    castManager.cleanup();
    setTimeout(() => onShutdown(), 100);
    return { ok: true, message: "shutting down" };
  });

  // --- Stay-Awake endpoints ---

  app.post<{ Body: { pin?: string } }>("/stay-awake/enable", async (req) => {
    let pin: string;
    try {
      pin = loadPin(req.body?.pin);
    } catch {
      return { ok: false, error: "PIN required" };
    }
    try {
      await stayAwake.enable(pin);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  app.post("/stay-awake/disable", async () => {
    await stayAwake.disable();
    return { ok: true };
  });

  app.get("/stay-awake/status", async () => {
    const props = await stayAwake.status();
    return {
      enabled: stayAwake.isEnabled,
      properties: props,
    };
  });

  // --- Logcat endpoints ---

  app.post<{ Body: { filter?: string } }>("/logcat/start", async (req) => {
    const filter = req.body?.filter;
    const result = await logcat.start(filter);
    return { ok: true, file: result.file, pid: result.pid };
  });

  app.post("/logcat/stop", async () => {
    logcat.stop();
    return { ok: true };
  });

  app.get("/logcat/status", async () => {
    return logcat.status();
  });

  app.get<{ Querystring: { lines?: string } }>("/logcat/read", async (req) => {
    const lineCount = parseInt(req.query.lines || "50", 10);
    const lines = logcat.readTail(lineCount);
    return { lines };
  });

  // --- Deploy endpoint ---

  app.post<{ Body: { apk_path: string; crash_wait_ms?: number } }>(
    "/deploy",
    async (req) => {
      const { apk_path, crash_wait_ms } = req.body ?? {};
      if (!apk_path) {
        return { ok: false, error: "apk_path required" };
      }

      let pin: string | undefined;
      try {
        pin = loadPin();
      } catch {
        // No PIN configured
      }

      const result: DeployResult = await deploy(
        { apkPath: apk_path, crashWaitMs: crash_wait_ms, pin },
        stayAwake,
        logcat,
      );
      return result;
    },
  );

  // --- Cast endpoints ---

  app.post<{
    Body: { listen_port?: number; width?: number; height?: number };
  }>("/cast/start", async (req) => {
    if (castManager.isActive) {
      return { ok: true, already_running: true };
    }
    try {
      await castManager.start({
        listenPort: req.body?.listen_port,
        width: req.body?.width,
        height: req.body?.height,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  app.post("/cast/stop", async () => {
    const session = castManager.getSession();
    if (!session?.connected) return { error: "cast not active" };
    await castManager.stop();
    castManager.broadcastToast("Casting stopped");
    return { ok: true };
  });

  app.post("/cast/restart", async () => {
    try {
      await castManager.restart();
      return { ok: true, msg: "restarting cast session" };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  app.get("/cast/events", async (_req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Send full status snapshot immediately
    const init = castManager.getStatus();
    reply.raw.write(`event: status\ndata: ${JSON.stringify(init)}\n\n`);
    castManager.addSSEClient(reply.raw);
    _req.raw.on("close", () => castManager.removeSSEClient(reply.raw));
  });

  app.get("/cast/help", async (_req, reply) => {
    const help = `quest-dev cast — REST API

GET endpoints
  /cast/help              This help screen
  /cast/screenshot        Latest frame as JPEG (503 if no frame)
  /cast/stream            MJPEG stream (multipart/x-mixed-replace)
  /cast/status            JSON: connected, running, resolution, fps, frame_count, pose
  /cast/layers            JSON: available layers and active layer ID
  /cast/events            SSE stream: state changes and toast notifications

POST endpoints (JSON body)
  /cast/start             Start casting (optional: { listen_port, width, height })
  /cast/stop              Stop casting (daemon stays running)
  /cast/restart           Restart cast session
  /cast/config            Set resolution
                            { width: 2064, height: 1162 }
  /cast/eye               Set eye mode
                            { mode: "left" | "right" | "stereo" }
  /cast/pose              Set or nudge camera pose
                            Absolute: { x, y, z, yaw, pitch }
                            Delta:    { dx, dy, dz, d_yaw, d_pitch }
  /cast/pose-loop         Toggle periodic pose refresh (~27 Hz)
                            { active: true | false }   (omit to toggle)
  /cast/click             Tap at normalised screen coordinates
                            { x: 0.5, y: 0.5, layer, hold_ms: 50 }
  /cast/gaze              Gaze-based interaction
                            { action: "enable" }
                            { action: "click", yaw, pitch, dwell_ms: 1200 }
  /cast/mud               Send raw MUD payload
                            { type: 0, payload_hex: "..." }
  /cast/home              Press the Home button (ADB keyevent)
  /cast/reset-view        Reset camera to default pose, stop pose loop
`;
    return reply.type("text/plain").send(help);
  });

  app.get("/cast/screenshot", async (_req, reply) => {
    const session = castManager.getSession();
    if (!session) return reply.code(503).send({ error: "cast not active" });
    const jpeg = session.getScreenshot();
    if (jpeg) {
      return reply.type("image/jpeg").send(jpeg);
    }
    return reply.code(503).send({ error: "no frame available" });
  });

  app.get("/cast/stream", async (_req, reply) => {
    const session = castManager.getSession();
    if (!session?.running) {
      return reply.code(503).send({ error: "cast not active" });
    }
    reply.raw.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache",
      Connection: "close",
    });

    const interval = setInterval(() => {
      const s = castManager.getSession();
      if (!s?.running) {
        clearInterval(interval);
        reply.raw.end();
        return;
      }
      const jpeg = s.getScreenshot();
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

  app.get("/cast/status", async () => {
    return castManager.getStatus();
  });

  app.get("/cast/layers", async () => {
    const session = castManager.getSession();
    if (!session) return { layers: {}, active_layer_id: 0 };
    const layers: Record<string, unknown> = {};
    for (const [id, info] of session.layers) {
      layers[String(id)] = info;
    }
    return { layers, active_layer_id: session.layerId };
  });

  // --- Cast POST endpoints ---

  app.post<{ Body: { pitch?: number; yaw?: number } }>(
    "/cast/rotate",
    async (req) => {
      const session = castManager.getSession();
      if (!session?.connected) return { error: "cast not active" };
      const { pitch = 0, yaw = 0 } = req.body ?? {};
      session.sendRotation(pitch, yaw);
      return { ok: true, pitch, yaw };
    },
  );

  app.post<{
    Body: {
      forward?: number;
      strafe?: number;
      yaw?: number;
      pitch?: number;
    };
  }>("/cast/move", async (req) => {
    const session = castManager.getSession();
    if (!session?.connected) return { error: "cast not active" };
    const { forward = 0, strafe = 0, yaw = 0, pitch = 0 } = req.body ?? {};
    session.sendRotation(pitch, yaw, forward, strafe);
    return { ok: true };
  });

  app.post<{ Body: { width?: number; height?: number } }>(
    "/cast/config",
    async (req) => {
      const session = castManager.getSession();
      if (!session?.connected) return { error: "cast not active" };
      const width = req.body?.width ?? session.width;
      const height = req.body?.height ?? session.height;
      session.sendDisplayConfig(width, height);
      castManager.broadcastToast(`Resolution: ${width}\u00d7${height}`);
      castManager.broadcastStatus();
      return { ok: true, width, height };
    },
  );

  app.post<{ Body: { mode?: string } }>("/cast/eye", async (req) => {
    const session = castManager.getSession();
    if (!session?.connected) return { error: "cast not active" };
    const mode = req.body?.mode ?? "left";
    const eyeMap: Record<string, number> = {
      left: EYE_LEFT,
      right: EYE_RIGHT,
      stereo: EYE_STEREO,
      both: EYE_STEREO,
    };
    const eye = eyeMap[mode] ?? EYE_LEFT;
    session.sendDisplayConfig(session.width, session.height, eye);
    castManager.broadcastToast(`Eye mode: ${mode}`);
    castManager.broadcastStatus();
    return { ok: true, mode };
  });

  app.post<{
    Body: { x?: number; y?: number; layer?: number; hold_ms?: number };
  }>("/cast/click", async (req) => {
    const session = castManager.getSession();
    if (!session?.connected) return { error: "cast not active" };
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
  });

  app.post<{
    Body: {
      x?: number;
      y?: number;
      z?: number;
      yaw?: number;
      pitch?: number;
      dx?: number;
      dy?: number;
      dz?: number;
      d_yaw?: number;
      d_pitch?: number;
    };
  }>("/cast/pose", async (req) => {
    const session = castManager.getSession();
    if (!session?.connected) return { error: "cast not active" };
    const data = req.body ?? {};

    // Absolute pose set
    if (
      "x" in data ||
      "y" in data ||
      "z" in data ||
      "yaw" in data ||
      "pitch" in data
    ) {
      session.setPoseAbsolute({
        x: data.x,
        y: data.y,
        z: data.z,
        yaw: data.yaw,
        pitch: data.pitch,
      });
    }
    // Incremental deltas
    if (
      "dx" in data ||
      "dy" in data ||
      "dz" in data ||
      "d_yaw" in data ||
      "d_pitch" in data
    ) {
      session.applyPoseDelta({
        dForward: data.dz ?? 0,
        dStrafe: data.dx ?? 0,
        dUp: data.dy ?? 0,
        dYaw: data.d_yaw ?? 0,
        dPitch: data.d_pitch ?? 0,
      });
    }

    castManager.broadcastStatus();
    return { ok: true };
  });

  app.post<{
    Body: {
      action?: string;
      yaw?: number;
      pitch?: number;
      dwell_ms?: number;
    };
  }>("/cast/gaze", async (req) => {
    const session = castManager.getSession();
    if (!session?.connected) return { error: "cast not active" };
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

      return {
        ok: true,
        action: "click",
        yaw: Math.round(yaw * 10000) / 10000,
        pitch: Math.round(pitch * 10000) / 10000,
        dwell_ms: dwellMs,
      };
    }

    return { error: `unknown action: ${action}` };
  });

  app.post<{ Body: { active?: boolean } }>(
    "/cast/pose-loop",
    async (req) => {
      const session = castManager.getSession();
      if (!session?.connected) return { error: "cast not active" };
      const active = req.body?.active ?? !session.poseLoopActive;
      if (active) {
        session.startPoseLoop();
      } else {
        session.stopPoseLoop();
      }
      castManager.broadcastStatus();
      return { ok: true, pose_loop: session.poseLoopActive };
    },
  );

  app.post("/cast/reset-view", async () => {
    const session = castManager.getSession();
    if (!session?.connected) return { error: "cast not active" };
    session.resetView();
    castManager.broadcastToast("View reset");
    castManager.broadcastStatus();
    return { ok: true, mode: "normal" };
  });

  app.post("/cast/home", async () => {
    try {
      await execCommand("adb", [
        "shell",
        "input",
        "keyevent",
        "KEYCODE_HOME",
      ]);
      castManager.broadcastToast("Home");
      return { ok: true };
    } catch {
      return { error: "failed to send home key" };
    }
  });

  app.post<{ Body: { type?: number; payload_hex?: string } }>(
    "/cast/mud",
    async (req) => {
      const session = castManager.getSession();
      if (!session?.connected) return { error: "cast not active" };
      const typeId = req.body?.type ?? 0;
      const payloadHex = req.body?.payload_hex ?? "";
      const payload = payloadHex ? Buffer.from(payloadHex, "hex") : undefined;
      session.sendMud(typeId, payload);
      return { ok: true, type: typeId, payload_len: payload?.length ?? 0 };
    },
  );

  await app.listen({ port, host: "0.0.0.0" });
  return app;
}
