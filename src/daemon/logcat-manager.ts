/**
 * Logcat manager for the daemon process.
 * Manages adb logcat capture to timestamped files.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
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

    // Clear ring buffer (with timeout — adb logcat -c can hang on flaky connections)
    try {
      await Promise.race([
        execCommand("adb", adbArgs("logcat", "-c")),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
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
    closeSync(fd); // child process owns the fd now

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

    if (file && existsSync(file)) {
      const stats = this.getFileStats(file);
      if (stats) {
        size = stats.size;
      }
    }

    return {
      capturing,
      pid: capturing ? this.proc!.pid! : null,
      file,
      size,
    };
  }

  /** Read tail of current logcat file (reads only the last chunk, not the entire file) */
  readTail(lineCount: number = 50): string[] {
    const file = this.currentFile;
    if (!file || !existsSync(file)) {
      return [];
    }

    try {
      const stat = statSync(file);
      // Read ~200 bytes per line as a rough estimate for logcat lines
      const bytesToRead = Math.min(stat.size, lineCount * 200);
      const buffer = Buffer.alloc(bytesToRead);
      const fd = openSync(file, "r");
      try {
        readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
      } finally {
        closeSync(fd);
      }
      const lines = buffer.toString("utf-8").split("\n");
      return lines.slice(-lineCount);
    } catch {
      return [];
    }
  }

  /** Scan tail for crash patterns, optionally scoped to a package name */
  scanForCrash(lineCount: number = 200, packageName?: string): { crashed: boolean; lines: string[]; reason?: string; matchedLine?: string; matchedPattern?: string } {
    const tail = this.readTail(lineCount);

    // Patterns that are app-specific (only match if they mention our package)
    const pkgEscaped = packageName ? packageName.replace(/\./g, "\\.") : null;
    const crashPatterns: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /FATAL EXCEPTION/i,          label: "FATAL EXCEPTION" },
      { pattern: /panicked at/i,              label: "Rust panic" },
      { pattern: /signal \d+ \(SIG/i,         label: "signal/crash" },
      { pattern: /Native crash/i,             label: "native crash" },
      // These patterns are scoped to our package to avoid false positives
      // from other processes dying (e.g. com.oculus.assistant)
      ...(pkgEscaped ? [
        { pattern: new RegExp(`ANR in ${pkgEscaped}`, "i"), label: "ANR (not responding)" },
        { pattern: new RegExp(`Process ${pkgEscaped}.* has died`, "i"), label: "process died" },
        { pattern: new RegExp(`Force finishing activity.*${pkgEscaped}`, "i"), label: "force finishing activity" },
      ] : [
        { pattern: /ANR in/i,                   label: "ANR (not responding)" },
        { pattern: /Process .+ has died/i,      label: "process died" },
        { pattern: /Force finishing activity/i,  label: "force finishing activity" },
      ]),
    ];

    for (const line of tail) {
      for (const { pattern, label } of crashPatterns) {
        if (pattern.test(line)) {
          const idx = tail.indexOf(line);
          return {
            crashed: true,
            lines: tail.slice(idx),
            reason: label,
            matchedLine: line.trim(),
            matchedPattern: pattern.source,
          };
        }
      }
    }

    return { crashed: false, lines: [] };
  }

  /** Cleanup: stop capture */
  cleanup(): void {
    this.stop();
  }

  private getFileStats(filePath: string): { size: string } | null {
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

      return { size: sizeStr };
    } catch {
      return null;
    }
  }
}
