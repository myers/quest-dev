/**
 * Quest stay-awake command
 * Uses Meta Scriptable Testing API (content://com.oculus.rc) to disable
 * autosleep, guardian, and system dialogs for automated testing.
 *
 * Cleanup is critical: with autosleep disabled, the headset drains battery
 * quickly. A watchdog child process ensures cleanup happens even if the
 * parent is killed (TaskStop, terminal close, claude code exit).
 */

import { checkADBPath, getBatteryInfo, formatBatteryInfo } from '../utils/adb.js';
import { loadPin, loadConfig } from '../utils/config.js';
import { execCommand, execCommandFull } from '../utils/exec.js';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

export interface TestProperties {
  disable_guardian: boolean;
  disable_dialogs: boolean;
  disable_autosleep: boolean;
  set_proximity_close: boolean;
}

/**
 * Build ADB args for SET_PROPERTY call
 */
export function buildSetPropertyArgs(pin: string, enabled: boolean): string[] {
  return [
    'shell', 'content', 'call',
    '--uri', 'content://com.oculus.rc',
    '--method', 'SET_PROPERTY',
    '--extra', `disable_guardian:b:${enabled}`,
    '--extra', `disable_dialogs:b:${enabled}`,
    '--extra', `disable_autosleep:b:${enabled}`,
    '--extra', `set_proximity_close:b:${enabled}`,
    '--extra', `PIN:s:${pin}`,
  ];
}

/**
 * Parse GET_PROPERTY Bundle output into structured data
 * Input: "Bundle[{disable_guardian=true, set_proximity_close=true, disable_dialogs=true, disable_autosleep=true}]"
 */
export function parseTestProperties(output: string): TestProperties {
  const defaults: TestProperties = {
    disable_guardian: false,
    disable_dialogs: false,
    disable_autosleep: false,
    set_proximity_close: false,
  };

  const match = output.match(/Bundle\[\{(.+)\}\]/);
  if (!match) return defaults;

  const pairs = match[1].split(',').map(s => s.trim());
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value && key in defaults) {
      (defaults as any)[key] = value === 'true';
    }
  }

  return defaults;
}

/**
 * Call SET_PROPERTY to enable or disable test mode
 */
async function setTestProperties(pin: string, enabled: boolean): Promise<void> {
  const args = buildSetPropertyArgs(pin, enabled);
  await execCommand('adb', args);
}

/**
 * Call GET_PROPERTY and return parsed test properties
 */
async function getTestProperties(): Promise<TestProperties> {
  const result = await execCommandFull('adb', [
    'shell', 'content', 'call',
    '--uri', 'content://com.oculus.rc',
    '--method', 'GET_PROPERTY',
  ]);
  return parseTestProperties(result.stdout);
}

/**
 * Format test properties for display
 */
function formatTestProperties(props: TestProperties): string {
  const lines = [
    `  Guardian disabled:  ${props.disable_guardian}`,
    `  Dialogs disabled:  ${props.disable_dialogs}`,
    `  Autosleep disabled: ${props.disable_autosleep}`,
    `  Proximity close:   ${props.set_proximity_close}`,
  ];
  return lines.join('\n');
}

/**
 * Wake the Quest screen
 */
async function wakeScreen(): Promise<void> {
  await execCommand('adb', ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
}

/**
 * Show current test properties status
 */
export async function stayAwakeStatus(): Promise<void> {
  checkADBPath();
  const props = await getTestProperties();
  console.log('Scriptable Testing properties:');
  console.log(formatTestProperties(props));
}

/**
 * Manually disable test mode (restore all properties)
 */
export async function stayAwakeDisable(cliPin?: string): Promise<void> {
  checkADBPath();
  const pin = loadPin(cliPin);
  await setTestProperties(pin, false);
  console.log('Test mode disabled — guardian, dialogs, and autosleep restored');
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
        const args = buildSetPropertyArgs(pin, false);
        execSync(`adb ${args.join(' ')}`, { stdio: 'ignore' });

        const pidFile = `${os.homedir()}/.quest-dev-stay-awake.pid`;
        try { fs.unlinkSync(pidFile); } catch {}

        console.log('Test mode disabled — guardian, dialogs, and autosleep restored');
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
  const beforeProps = await getTestProperties();
  console.log('Current test properties:');
  console.log(formatTestProperties(beforeProps));

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

  // Enable test mode
  try {
    await setTestProperties(pin, true);
    console.log('Test mode enabled — guardian, dialogs, and autosleep disabled');
  } catch (error) {
    console.error('Failed to enable test mode:', (error as Error).message);
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

      const args = buildSetPropertyArgs(pin, false);
      execSync(`adb ${args.join(' ')}`, { stdio: 'ignore' });
      console.log('Test mode disabled — guardian, dialogs, and autosleep restored');
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
