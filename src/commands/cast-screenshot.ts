/**
 * Cast screenshot command — captures a per-eye/stereo VR frame via the
 * daemon's casting API, validates the bytes, and writes it to disk.
 *
 * Atomic workflow in one invocation:
 *   1. Ensure the daemon is running.
 *   2. POST /cast/start (idempotent).
 *   3. POST /cast/eye   (set eye mode).
 *   4. GET  /cast/screenshot  (raw JPEG bytes).
 *   5. Validate JPEG magic bytes (SOI + EOI); refuse non-images.
 *   6. Write to the output directory; add caption metadata if provided.
 *   7. Print the absolute path on stdout.
 *
 * Why this exists: callers who hand-roll `curl -o foo.jpg` against the
 * daemon risk saving a JSON error body with a `.jpg` extension. Downstream
 * consumers that mime-sniff by extension (e.g. Claude Code's Read tool) will
 * crash on such a file. This command guarantees the file it prints is a
 * real JPEG.
 */

import { resolve, join } from "path";
import { existsSync, statSync, writeFileSync } from "fs";
import { ensureDaemon, daemonFetch, type DaemonInfo } from "../daemon/client.js";
import { generateScreenshotFilename } from "../utils/filename.js";
import { addJpegFileComment } from "../utils/jpeg-comment.js";

export type CastEyeMode = "left" | "right" | "stereo";

export interface CastScreenshotOptions {
  mode: CastEyeMode;
  directory: string;
  caption?: string;
  port?: number;
  device?: string;
  host?: string;
}

function validateDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    console.error(`Error: Directory does not exist: ${dirPath}`);
    process.exit(1);
  }
  if (!statSync(dirPath).isDirectory()) {
    console.error(`Error: Path is not a directory: ${dirPath}`);
    process.exit(1);
  }
}

/**
 * Cheap but sufficient JPEG check: SOI marker at start (FF D8 FF) and EOI
 * at end (FF D9). This catches every failure mode we've actually hit —
 * empty files, JSON error bodies, truncated network transfers — without
 * pulling in a full image decoder.
 */
function isValidJpeg(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return false;
  if (buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) return false;
  return true;
}

async function httpGet(
  info: DaemonInfo,
  path: string,
): Promise<{ status: number; body: Buffer; contentType: string }> {
  const url = `http://127.0.0.1:${info.port}${path}`;
  const resp = await fetch(url);
  const body = Buffer.from(await resp.arrayBuffer());
  return {
    status: resp.status,
    body,
    contentType: resp.headers.get("content-type") ?? "",
  };
}

/**
 * Poll /cast/status until the decoder reports a frame. Falls through on
 * timeout so the /cast/screenshot fetch reports the real error.
 */
export async function waitForFrame(info: DaemonInfo, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await daemonFetch(info, "/cast/status")) as {
      has_frame?: boolean;
    };
    if (status?.has_frame) return;
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function castScreenshotCommand(
  opts: CastScreenshotOptions,
): Promise<void> {
  const resolvedDir = resolve(opts.directory);
  validateDirectory(resolvedDir);

  const info = await ensureDaemon({
    port: opts.port,
    device: opts.device,
    host: opts.host,
  });

  // 1. Start cast (idempotent — 200 if already running).
  const startResp = (await daemonFetch(info, "/cast/start", { body: {} })) as {
    ok?: boolean;
    error?: string;
    already_running?: boolean;
  };
  if (!startResp.ok) {
    console.error(`Failed to start cast: ${startResp.error ?? "unknown error"}`);
    process.exit(1);
  }

  // A start that actually started something (cold, or a recovery of a stalled
  // session) returns before the XRSP handshake has finished. Changing the eye
  // mode inside that window resets the stream and the session then sits at
  // frame_count 0 forever, so let the handshake land first.
  if (!startResp.already_running) {
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 2. Set eye mode.
  const eyeResp = (await daemonFetch(info, "/cast/eye", {
    body: { mode: opts.mode },
  })) as { ok?: boolean; error?: string };
  if (!eyeResp.ok) {
    console.error(`Failed to set eye mode: ${eyeResp.error ?? "unknown error"}`);
    process.exit(1);
  }

  // Small settle time so the mode change takes effect before we grab a frame,
  // then wait for the decoder to actually have one. A cold start — or a
  // /cast/start that just recovered a stalled session — needs a couple of
  // seconds, and /cast/screenshot 503s until then.
  await new Promise((r) => setTimeout(r, 500));
  await waitForFrame(info);

  // 3. Fetch frame.
  const { status, body, contentType } = await httpGet(info, "/cast/screenshot");
  if (status !== 200) {
    const preview = body.toString("utf8", 0, Math.min(body.length, 400));
    console.error(
      `/cast/screenshot returned HTTP ${status} (${contentType}): ${preview}`,
    );
    process.exit(1);
  }
  if (!contentType.startsWith("image/jpeg")) {
    const preview = body.toString("utf8", 0, Math.min(body.length, 400));
    console.error(
      `/cast/screenshot returned unexpected content-type ${contentType}: ${preview}`,
    );
    process.exit(1);
  }
  if (!isValidJpeg(body)) {
    console.error(
      `/cast/screenshot returned ${body.length} bytes that don't look like JPEG (missing SOI/EOI markers)`,
    );
    process.exit(1);
  }

  // 4. Write.
  const filename = generateScreenshotFilename(new Date(), opts.caption);
  const outputPath = join(resolvedDir, filename);
  writeFileSync(outputPath, body);

  // 5. Caption metadata (non-fatal).
  if (opts.caption) {
    try {
      addJpegFileComment(outputPath, opts.caption);
    } catch (err) {
      console.error(
        `Warning: failed to embed caption metadata: ${(err as Error).message}`,
      );
    }
  }

  console.log(outputPath);
}
