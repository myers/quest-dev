/**
 * Logcat manager for the daemon process.
 * Manages adb logcat capture to timestamped files.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  readFileSync,
  unlinkSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execCommand } from "../utils/exec.js";
import { verbose } from "../utils/verbose.js";
import { adbArgs } from "../utils/adb.js";

const LOG_DIR = resolve(process.env.LOG_DIR || "logs/logcat");
const LOGFILE_LINK = join(LOG_DIR, "latest.txt");

export interface LogcatStatus {
  capturing: boolean;
  pid: number | null;
  file: string | null;
  size: string | null;
  lines: number | null;
}

export class LogcatManager {
  private proc: ChildProcess | null = null;
  private currentFile: string | null = null;

  /** Whether logcat is currently capturing */
  get isCapturing(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /** Start logcat capture. Stops any previous capture first. */
  async start(filter?: string): Promise<{ file: string; pid: number }> {
    // Stop existing capture
    if (this.isCapturing) {
      this.stop();
    }

    // Ensure log directory
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }

    // Generate filename
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+/, "")
      .replace("T", "_")
      .slice(0, 15);
    const logFile = join(LOG_DIR, `logcat_${timestamp}.txt`);
    this.currentFile = logFile;

    // Clear ring buffer
    try {
      await execCommand("adb", adbArgs("logcat", "-c"));
    } catch (error) {
      verbose("Failed to clear logcat buffer:", (error as Error).message);
    }

    // Start logcat process
    const args = adbArgs("logcat", "-v", "threadtime");
    if (filter) {
      args.push(filter);
    }

    const fd = openSync(logFile, "w");
    this.proc = spawn("adb", args, {
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    this.proc.unref();

    // Update symlink
    try {
      if (existsSync(LOGFILE_LINK)) {
        unlinkSync(LOGFILE_LINK);
      }
      symlinkSync(`logcat_${timestamp}.txt`, LOGFILE_LINK);
    } catch {
      // Non-fatal
    }

    const pid = this.proc.pid!;
    console.log(`Logcat capture started (PID: ${pid}) → ${logFile}`);
    return { file: logFile, pid };
  }

  /** Stop logcat capture */
  stop(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGTERM");
        verbose(`Logcat capture stopped (PID: ${this.proc.pid})`);
      } catch {
        // Already dead
      }
    }
    this.proc = null;
  }

  /** Get capture status */
  status(): LogcatStatus {
    const capturing = this.isCapturing;
    const file = this.currentFile;
    let size: string | null = null;
    let lines: number | null = null;

    if (file && existsSync(file)) {
      const stats = this.getFileStats(file);
      if (stats) {
        size = stats.size;
        lines = stats.lines;
      }
    }

    return {
      capturing,
      pid: capturing ? this.proc!.pid! : null,
      file,
      size,
      lines,
    };
  }

  /** Read tail of current logcat file */
  readTail(lineCount: number = 50): string[] {
    const file = this.currentFile;
    if (!file || !existsSync(file)) {
      return [];
    }

    try {
      const content = readFileSync(file, "utf-8");
      const allLines = content.split("\n");
      return allLines.slice(-lineCount);
    } catch {
      return [];
    }
  }

  /** Scan tail for crash patterns */
  scanForCrash(lineCount: number = 200): { crashed: boolean; lines: string[] } {
    const tail = this.readTail(lineCount);
    const crashPatterns = [
      /FATAL EXCEPTION/i,
      /panicked at/i,
      /backtrace:/i,
      /signal \d+ \(SIG/i,
      /Native crash/i,
      /ANR in/i,
      /Process .+ has died/i,
      /Force finishing activity/i,
    ];

    const crashLines: string[] = [];
    let crashed = false;

    for (const line of tail) {
      for (const pattern of crashPatterns) {
        if (pattern.test(line)) {
          crashed = true;
          break;
        }
      }
      if (crashed) {
        // Once we find a crash, include this and all remaining lines
        const idx = tail.indexOf(line);
        return { crashed: true, lines: tail.slice(idx) };
      }
    }

    return { crashed: false, lines: [] };
  }

  /** Cleanup: stop capture */
  cleanup(): void {
    this.stop();
  }

  private getFileStats(filePath: string): { size: string; lines: number } | null {
    try {
      const stats = statSync(filePath);
      const sizeInBytes = stats.size;
      let sizeStr: string;

      if (sizeInBytes < 1024) {
        sizeStr = `${sizeInBytes}B`;
      } else if (sizeInBytes < 1024 * 1024) {
        sizeStr = `${(sizeInBytes / 1024).toFixed(1)}K`;
      } else {
        sizeStr = `${(sizeInBytes / (1024 * 1024)).toFixed(1)}M`;
      }

      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").length;

      return { size: sizeStr, lines };
    } catch {
      return null;
    }
  }
}
