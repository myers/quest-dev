/**
 * Unified Fastify server for the quest-dev daemon.
 * Hosts all endpoint groups: core, stay-awake, logcat, deploy, cast.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { loadPin, loadConfig } from "../utils/config.js";
import { getBatteryInfo, formatBatteryInfo } from "../utils/adb.js";
import { verbose } from "../utils/verbose.js";
import type { StayAwakeManager } from "./stay-awake-manager.js";
import type { LogcatManager } from "./logcat-manager.js";
import { deploy, type DeployResult } from "./deploy.js";

export interface DaemonServerOptions {
  port: number;
  stayAwake: StayAwakeManager;
  logcat: LogcatManager;
  onActivity: () => void;
  onShutdown: () => void;
}

export async function createDaemonServer(
  options: DaemonServerOptions,
): Promise<FastifyInstance> {
  const { port, stayAwake, logcat, onActivity, onShutdown } = options;
  const config = loadConfig();

  const app = Fastify({ logger: false });

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
    // Respond first, then shutdown
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

  await app.listen({ port, host: "127.0.0.1" });
  return app;
}
