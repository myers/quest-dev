/**
 * H.264 to JPEG frame decoder using a persistent ffmpeg subprocess.
 *
 * Spawns ffmpeg with H.264 stdin → MJPEG stdout, extracts individual
 * JPEG frames by scanning for SOI (FF D8) / EOI (FF D9) markers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import which from "which";
import { verbose } from "../utils/verbose.js";

// JPEG markers
const JPEG_SOI = 0xffd8;
const JPEG_EOI_0 = 0xff;
const JPEG_EOI_1 = 0xd9;

/**
 * Extract complete JPEG frames from a buffer.
 * Returns extracted frames and the remaining unprocessed bytes.
 */
export function extractJpegFrames(buf: Buffer): {
  frames: Buffer[];
  remainder: Buffer;
} {
  const frames: Buffer[] = [];
  let data = buf;

  while (true) {
    // Find SOI marker (FF D8)
    let start = -1;
    for (let i = 0; i < data.length - 1; i++) {
      if (data[i] === 0xff && data[i + 1] === 0xd8) {
        start = i;
        break;
      }
    }
    if (start < 0) {
      // No SOI found — discard everything
      return { frames, remainder: Buffer.alloc(0) };
    }

    // Find EOI marker (FF D9) after SOI
    let end = -1;
    for (let i = start + 2; i < data.length - 1; i++) {
      if (data[i] === JPEG_EOI_0 && data[i + 1] === JPEG_EOI_1) {
        end = i + 2; // include both EOI bytes
        break;
      }
    }
    if (end < 0) {
      // Incomplete frame — keep from SOI onward
      return { frames, remainder: data.subarray(start) };
    }

    frames.push(Buffer.from(data.subarray(start, end)));
    data = data.subarray(end);
  }
}

export interface FrameDecoderEvents {
  frame: [jpeg: Buffer];
  error: [err: Error];
}

/**
 * Persistent ffmpeg-based H.264 → JPEG decoder.
 *
 * Usage:
 *   const decoder = new FrameDecoder();
 *   decoder.start();
 *   decoder.feed(nalData);
 *   const jpeg = decoder.getFrame();
 *   decoder.stop();
 */
export class FrameDecoder extends EventEmitter {
  private proc: ChildProcess | null = null;
  private latestFrame: Buffer | null = null;
  private readBuffer: Buffer = Buffer.alloc(0);
  private running = false;

  /** Check that ffmpeg is available on PATH. */
  static checkFfmpeg(): void {
    try {
      which.sync("ffmpeg");
    } catch {
      throw new Error(
        "ffmpeg not found on PATH. Install ffmpeg to enable video decoding.",
      );
    }
  }

  /** Start the persistent ffmpeg decoder process. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.readBuffer = Buffer.alloc(0);

    this.proc = spawn(
      "ffmpeg",
      [
        "-loglevel", "error",
        "-f", "h264", "-i", "pipe:0",
        "-q:v", "3",
        "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
      const { frames, remainder } = extractJpegFrames(this.readBuffer);
      this.readBuffer = remainder;
      if (frames.length > 0) {
        this.latestFrame = frames[frames.length - 1];
        this.emit("frame", this.latestFrame);
      }
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      verbose("ffmpeg stderr:", chunk.toString().trim());
    });

    this.proc.on("exit", (code) => {
      verbose("ffmpeg decoder exited with code", code);
      this.running = false;
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
      this.running = false;
    });

    verbose("Started persistent ffmpeg decoder");
  }

  /** Feed H.264 NAL data to the decoder. */
  feed(nalData: Buffer): void {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(nalData);
    } catch {
      verbose("Decoder pipe broken, restarting...");
      this.stop();
      this.start();
      try {
        this.proc?.stdin?.write(nalData);
      } catch {
        // Give up on this NAL
      }
    }
  }

  /** Get the latest decoded JPEG frame, or null if none available. */
  getFrame(): Buffer | null {
    return this.latestFrame;
  }

  /** Stop the decoder and kill the ffmpeg process. */
  stop(): void {
    this.running = false;
    if (this.proc) {
      try {
        this.proc.stdin?.end();
        this.proc.kill();
      } catch {
        // Already dead
      }
      this.proc = null;
    }
    this.readBuffer = Buffer.alloc(0);
  }

  /** Whether the decoder is currently running. */
  get isRunning(): boolean {
    return this.running;
  }
}
