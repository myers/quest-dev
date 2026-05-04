/**
 * Quest stay-awake command
 * Uses Meta Scriptable Testing API (content://com.oculus.rc) to turn off
 * Quest protections (autosleep, guardian, system dialogs) for automated testing.
 *
 * Cleanup is critical: with autosleep off, the headset drains battery
 * quickly. A watchdog child process ensures cleanup happens even if the
 * parent is killed (TaskStop, terminal close, claude code exit).
 */

import { checkADBPath, getBatteryInfo, formatBatteryInfo, adbArgs } from '../utils/adb.js';
import { loadPin, loadConfig } from '../utils/config.js';
import { execCommand } from '../utils/exec.js';
import { execFileSync, spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
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
 * Child watchdog process - polls for parent death and cleans up
 */
export async function stayAwakeWatchdog(parentPid: number, pin: string): Promise<void> {
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

        const pidFile = `${os.homedir()}/.quest-dev-stay-awake.pid`;
        try { fs.unlinkSync(pidFile); } catch {}

        console.log('Stay-awake off — guardian, dialogs, autosleep on');
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

  // PID file management
  const pidFilePath = `${os.homedir()}/.quest-dev-stay-awake.pid`;

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
    console.log('Stay-awake on — guardian, dialogs, autosleep off');
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

  console.log(`Quest will stay awake (idle timeout: ${Math.round(idleTimeout / 1000)}s, low battery exit: ${lowBattery}%). Press Ctrl-C to restore.`);

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

  // Battery monitoring loop (every 60s)
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
      }
    } catch {
      // Ignore battery check failures (device might be briefly unavailable)
    }
  }, 60000);

  // Keep process alive
  console.log('Keeping Quest awake...');
  await new Promise<void>((resolve) => {
    process.on('exit', () => resolve());
  });
}
