/**
 * Quest logcat command
 * Captures Android logcat to files for Quest debugging
 *
 * CRITICAL: Quest's ring buffer fills in seconds under VR load.
 * Always capture to a file BEFORE testing to avoid losing crash logs.
 */

import { resolve, join } from 'path';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, symlinkSync, statSync, readlinkSync, openSync } from 'fs';
import { spawn } from 'child_process';
import { checkADBPath, checkADBDevices } from '../utils/adb.js';
import { execCommand, execCommandFull } from '../utils/exec.js';

const LOG_DIR = process.env.LOG_DIR || 'logs/logcat';
const PID_FILE = join(LOG_DIR, '.logcat_pid');
const LOGFILE_LINK = join(LOG_DIR, 'latest.txt');

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Check if a process is running by PID
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read PID from PID file
 */
function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }
  try {
    const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
    return parseInt(pidStr, 10);
  } catch {
    return null;
  }
}

/**
 * Write PID to PID file
 */
function writePidFile(pid: number): void {
  writeFileSync(PID_FILE, pid.toString(), 'utf-8');
}

/**
 * Delete PID file
 */
function deletePidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

/**
 * Get the latest log file path
 */
function getLatestLogFile(): string | null {
  if (!existsSync(LOGFILE_LINK)) {
    return null;
  }
  try {
    const target = readlinkSync(LOGFILE_LINK);
    const fullPath = join(LOG_DIR, target);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  } catch {
    // Symlink might be broken
  }
  return null;
}

/**
 * Get file size and line count
 */
function getFileStats(filePath: string): { size: string; lines: number } | null {
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

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;

    return { size: sizeStr, lines };
  } catch {
    return null;
  }
}

/**
 * Start logcat capture
 */
export async function startCommand(filter?: string): Promise<void> {
  // Check for existing capture
  const existingPid = readPidFile();
  if (existingPid && isProcessRunning(existingPid)) {
    console.error('Already capturing. Use "quest-dev logcat stop" first.');
    process.exit(1);
  }

  // Check prerequisites
  checkADBPath();
  await checkADBDevices();

  ensureLogDir();

  // Generate log filename
  const timestamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '_')
    .slice(0, 15); // YYYYMMDD_HHMMSS
  const logFile = join(LOG_DIR, `logcat_${timestamp}.txt`);

  console.log(`Starting capture to: ${logFile}`);

  // Clear the buffer first - critical for Quest
  try {
    await execCommand('adb', ['logcat', '-c']);
    console.log('Ring buffer cleared.');
  } catch (error) {
    console.error('Failed to clear ring buffer:', (error as Error).message);
    process.exit(1);
  }

  if (filter) {
    console.log(`Filter: ${filter}`);
  }

  // Start background logcat process
  const args = ['logcat', '-v', 'threadtime'];
  if (filter) {
    args.push(filter);
  }

  // Open file for writing
  const fd = openSync(logFile, 'w');

  const proc = spawn('adb', args, {
    stdio: ['ignore', fd, fd],
    detached: true
  });

  // Unref so parent can exit immediately
  proc.unref();

  // Save PID
  writePidFile(proc.pid!);

  // Update symlink
  try {
    if (existsSync(LOGFILE_LINK)) {
      unlinkSync(LOGFILE_LINK);
    }
    symlinkSync(`logcat_${timestamp}.txt`, LOGFILE_LINK);
  } catch (error) {
    console.warn('Warning: Failed to create symlink:', (error as Error).message);
  }

  console.log(`Capturing (PID: ${proc.pid})`);
  console.log('');
  console.log('Now run your test. When done: quest-dev logcat stop');
}

/**
 * Stop logcat capture
 */
export async function stopCommand(): Promise<void> {
  const pid = readPidFile();

  if (!pid) {
    console.log('No capture in progress');
    return;
  }

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Capture stopped (PID: ${pid})`);
    } catch (error) {
      console.log(`Capture process already ended (PID: ${pid})`);
    }
  } else {
    console.log('Capture process already ended');
  }

  deletePidFile();

  // Show file info
  const latestFile = getLatestLogFile();
  if (latestFile) {
    const stats = getFileStats(latestFile);
    if (stats) {
      console.log('');
      console.log(`Log file: ${latestFile}`);
      console.log(`Size: ${stats.size} (${stats.lines} lines)`);
    }
  }
}

/**
 * Show capture status
 */
export async function statusCommand(): Promise<void> {
  const pid = readPidFile();

  if (pid && isProcessRunning(pid)) {
    console.log(`Capturing (PID: ${pid})`);

    const latestFile = getLatestLogFile();
    if (latestFile) {
      const stats = getFileStats(latestFile);
      if (stats) {
        console.log(`File: ${latestFile}`);
        console.log(`Size: ${stats.size} (${stats.lines} lines)`);
      }
    }
  } else {
    console.log('Not capturing');

    // Show recent logs
    if (existsSync(LOG_DIR)) {
      console.log('');
      console.log('Recent logs:');
      try {
        const { readdirSync } = await import('fs');
        const files = readdirSync(LOG_DIR)
          .filter(f => f.endsWith('.txt'))
          .map(f => ({ name: f, mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5);
        files.forEach(f => console.log('  ' + f.name));
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Tail current capture
 */
export async function tailCommand(): Promise<void> {
  const latestFile = getLatestLogFile();

  if (!latestFile) {
    console.error('No active log file');
    process.exit(1);
  }

  console.log(`Tailing: ${latestFile}`);
  console.log('Press Ctrl+C to stop\n');

  // Use tail -f
  const tailProc = spawn('tail', ['-f', latestFile], {
    stdio: 'inherit'
  });

  tailProc.on('error', (error) => {
    console.error('Failed to tail log:', error.message);
    process.exit(1);
  });
}
