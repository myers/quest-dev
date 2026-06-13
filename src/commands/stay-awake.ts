/**
 * Quest stay-awake command
 * Uses Meta Scriptable Testing API (content://com.oculus.rc) to turn off
 * Quest protections (autosleep, guardian, system dialogs) for automated testing.
 *
 * Cleanup is critical: with autosleep off, the headset drains battery
 * quickly. A watchdog child process ensures cleanup happens even if the
 * parent is killed (TaskStop, terminal close, claude code exit).
 */

import { checkADBPath, getBatteryInfo, formatBatteryInfo, adbArgs, type BatteryInfo } from '../utils/adb.js';
import { loadPin, loadConfig } from '../utils/config.js';
import { execCommand } from '../utils/exec.js';
import { execFileSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { join, dirname } from 'path';
import { runtimeDir, sanitizeSerial } from '../utils/paths.js';
import {
  type QuestProtections,
  buildSetPropertyArgs,
  parseQuestProtections,
  setQuestProtections,
  getQuestProtections,
  formatQuestProtections,
} from '../utils/quest-protections.js';

// Re-export for tests
export { type QuestProtections, buildSetPropertyArgs, parseQuestProtections };

/**
 * Accumulate how long the headset has been unplugged, across battery polls.
 *
 * Each poll either adds the elapsed interval (while `not charging`) or resets
 * the counter to zero (while `charging`/`fast charging`). A brief unplug that
 * returns to charging before the grace window elapses therefore clears itself,
 * so a cable bump or PD renegotiation doesn't end the session.
 *
 * @param accumulatedMs - unplugged time accumulated so far
 * @param state - current battery charge state
 * @param intervalMs - time since the previous poll
 * @returns the new accumulated unplugged time
 */
export function trackUnpluggedDuration(
  accumulatedMs: number,
  state: BatteryInfo['state'],
  intervalMs: number,
): number {
  if (state === 'not charging') {
    return accumulatedMs + intervalMs;
  }
  return 0;
}

/**
 * Decide whether to exit because the headset has been unplugged too long.
 *
 * A threshold of 0 (or negative) disables the feature — the session stays
 * awake on battery until the separate low-battery level exit fires.
 *
 * @param accumulatedUnpluggedMs - unplugged time accumulated so far
 * @param unpluggedTimeoutMs - grace window; 0/negative disables the check
 */
export function shouldExitOnUnplug(
  accumulatedUnpluggedMs: number,
  unpluggedTimeoutMs: number,
): boolean {
  if (unpluggedTimeoutMs <= 0) return false;
  return accumulatedUnpluggedMs >= unpluggedTimeoutMs;
}

/**
 * Wake the Quest screen
 */
async function wakeScreen(): Promise<void> {
  await execCommand('adb', adbArgs('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'));
}

/**
 * Show current Quest protection status
 */
export async function stayAwakeStatus(): Promise<void> {
  checkADBPath();
  const props = await getQuestProtections();
  console.log('Quest protections:');
  console.log(formatQuestProtections(props));
}

/**
 * Manually turn stay-awake off (restore all Quest protections)
 */
export async function stayAwakeOff(cliPin?: string): Promise<void> {
  checkADBPath();
  const pin = loadPin(cliPin);
  await setQuestProtections(pin, true);
  const props = await getQuestProtections();
  console.log('Stay-awake off:');
  console.log(formatQuestProtections(props));
}

/**
 * Per-serial PID file path for stay-awake, under the XDG runtime dir.
 */
export function stayAwakePidPath(serial: string): string {
  return join(runtimeDir(), `stay-awake-${sanitizeSerial(serial)}.pid`);
}

/**
 * Child watchdog process - polls for parent death and cleans up
 */
export async function stayAwakeWatchdog(parentPid: number, pin: string, serial: string): Promise<void> {
  const pollInterval = 5000;

  const checkParent = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log('Parent process died, restoring Quest settings...');
      clearInterval(checkParent);

      try {
        const args = adbArgs(...buildSetPropertyArgs(pin, true));
        execFileSync('adb', args, { stdio: 'ignore' });

        const pidFile = stayAwakePidPath(serial);
        try { fs.unlinkSync(pidFile); } catch {}

        console.log('Stay-awake off — guardian, dialogs, autosleep, proximity on');
      } catch (err) {
        console.error('Failed to restore settings:', (err as Error).message);
      }

      process.exit(0);
    }
  }, pollInterval);
}

/**
 * Main stay-awake command handler
 */
export async function stayAwakeCommand(
  cliPin?: string,
  cliIdleTimeout?: number,
  cliLowBattery?: number,
  verbose: boolean = false,
  cliUnpluggedTimeout?: number,
  serial: string = '',
): Promise<void> {
  checkADBPath();

  // Check devices
  try {
    const output = await execCommand('adb', ['devices']);
    const lines = output.trim().split('\n').slice(1);
    const devices = lines.filter(line => line.trim() && !line.includes('List of devices'));

    if (devices.length === 0) {
      console.error('Error: No ADB devices connected');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error: Failed to list ADB devices');
    process.exit(1);
  }

  const config = loadConfig();
  const pin = loadPin(cliPin);
  const idleTimeout = cliIdleTimeout ?? config.idleTimeout ?? 300000;
  const lowBattery = cliLowBattery ?? config.lowBattery ?? 10;
  // Grace window for a sustained unplug. On by default (5 min) so an unplugged
  // headset exits before draining; 0 disables it (stay awake on battery until
  // the low-battery level exit). A brief unplug under this window is forgiven.
  const unpluggedTimeout = cliUnpluggedTimeout ?? config.unpluggedTimeout ?? 300000;

  // PID file management
  const pidFilePath = stayAwakePidPath(serial);

  if (fs.existsSync(pidFilePath)) {
    const existingPid = parseInt(fs.readFileSync(pidFilePath, 'utf-8'));
    try {
      process.kill(existingPid, 0);
      console.error(`Error: stay-awake is already running (PID: ${existingPid})`);
      process.exit(1);
    } catch {
      fs.unlinkSync(pidFilePath);
    }
  }

  // Show current state
  const beforeProps = await getQuestProtections();
  console.log('Quest protections (before):');
  console.log(formatQuestProtections(beforeProps));

  // Write PID file
  try {
    fs.mkdirSync(dirname(pidFilePath), { recursive: true });
    fs.writeFileSync(pidFilePath, process.pid.toString());
  } catch (error) {
    console.warn('Failed to write PID file');
  }

  // Spawn watchdog child process
  let childProcess: ChildProcess | null = null;
  try {
    childProcess = spawn(process.execPath, [
      process.argv[1],
      'stay-awake-watchdog',
      '--parent-pid', process.pid.toString(),
      '--pin', pin,
      '--serial', serial,
    ], {
      detached: true,
      stdio: 'ignore',
    });
    childProcess.unref();
  } catch (error) {
    console.warn('Failed to spawn watchdog child process');
  }

  // Turn stay-awake on (turn Quest protections off)
  try {
    await setQuestProtections(pin, false);
    console.log('Stay-awake on — guardian, dialogs, autosleep, proximity off');
  } catch (error) {
    console.error('Failed to turn stay-awake on:', (error as Error).message);
    console.error('Requires Quest OS v44+ and a valid Meta Store PIN.');
    process.exit(1);
  }

  // Wake screen
  try {
    await wakeScreen();
    console.log('Quest screen woken up');
  } catch (error) {
    console.error('Failed to wake screen:', (error as Error).message);
  }

  // Battery monitoring state
  let lastReportedBucket = -1; // Track 5% boundary crossings

  // Initial battery check
  try {
    const battery = await getBatteryInfo();
    console.log(`Battery: ${formatBatteryInfo(battery)}`);
    lastReportedBucket = Math.floor(battery.level / 5) * 5;
  } catch (error) {
    console.warn('Failed to read battery status');
  }

  const unpluggedExitDesc = unpluggedTimeout > 0
    ? `unplugged exit: ${Math.round(unpluggedTimeout / 1000)}s`
    : 'unplugged exit: off';
  console.log(`Quest will stay awake (idle timeout: ${Math.round(idleTimeout / 1000)}s, low battery exit: ${lowBattery}%, ${unpluggedExitDesc}). Press Ctrl-C to restore.`);

  // Idle timer
  let idleTimerHandle: NodeJS.Timeout | null = null;
  let cleanupInProgress = false;

  const resetIdleTimer = () => {
    if (idleTimerHandle) clearTimeout(idleTimerHandle);
    idleTimerHandle = setTimeout(() => {
      console.log('\nIdle timeout reached, exiting...');
      cleanup();
    }, idleTimeout);
  };

  // Cleanup handler
  const cleanup = () => {
    if (cleanupInProgress) return;
    cleanupInProgress = true;

    if (idleTimerHandle) clearTimeout(idleTimerHandle);
    if (batteryInterval) clearInterval(batteryInterval);

    if (childProcess) {
      try { childProcess.kill(); } catch {}
    }

    console.log('\nRestoring settings...');
    try {
      try { fs.unlinkSync(pidFilePath); } catch {}

      const args = adbArgs(...buildSetPropertyArgs(pin, true));
      execFileSync('adb', args, { stdio: 'ignore' });
      console.log('Stay-awake off — guardian, dialogs, autosleep on');
    } catch (error) {
      console.error('Failed to restore settings:', (error as Error).message);
    }
    process.exit(0);
  };

  // Signal handlers
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  // Activity reset via SIGUSR1
  process.on('SIGUSR1', () => {
    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] Activity detected, resetting idle timer`);
    resetIdleTimer();
  });

  // Start idle timer
  resetIdleTimer();

  // Battery monitoring loop
  const BATTERY_POLL_MS = 60000;
  let unpluggedMs = 0; // accumulated time spent unplugged across polls

  const batteryInterval = setInterval(async () => {
    try {
      const battery = await getBatteryInfo();
      const currentBucket = Math.floor(battery.level / 5) * 5;

      if (verbose) {
        console.log(`Battery: ${formatBatteryInfo(battery)}`);
      } else if (currentBucket !== lastReportedBucket) {
        console.log(`Battery: ${formatBatteryInfo(battery)}`);
      }
      lastReportedBucket = currentBucket;

      if (battery.level <= lowBattery && battery.state === 'not charging') {
        console.log(`\nBattery critically low (${battery.level}%), exiting to preserve battery...`);
        cleanup();
        return;
      }

      // Exit on a sustained unplug (a brief unplug under the grace window is forgiven).
      unpluggedMs = trackUnpluggedDuration(unpluggedMs, battery.state, BATTERY_POLL_MS);
      if (shouldExitOnUnplug(unpluggedMs, unpluggedTimeout)) {
        console.log(`\nUnplugged for ${Math.round(unpluggedMs / 1000)}s, exiting to preserve battery...`);
        cleanup();
      }
    } catch {
      // Ignore battery check failures (device might be briefly unavailable)
    }
  }, BATTERY_POLL_MS);

  // Keep process alive
  console.log('Keeping Quest awake...');
  await new Promise<void>((resolve) => {
    process.on('exit', () => resolve());
  });
}
