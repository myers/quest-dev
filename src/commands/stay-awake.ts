/**
 * Quest stay-awake command
 * Keeps Quest screen awake by setting screen timeout to 24 hours
 * Restores original timeout on exit (Ctrl-C)
 */

import { checkADBPath } from '../utils/adb.js';
import { execCommand } from '../utils/exec.js';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Get current screen timeout setting
 */
async function getScreenTimeout(): Promise<number> {
  const output = await execCommand('adb', ['shell', 'settings', 'get', 'system', 'screen_off_timeout']);
  return parseInt(output.trim(), 10);
}

/**
 * Set screen timeout (in milliseconds)
 */
async function setScreenTimeout(timeout: number): Promise<void> {
  await execCommand('adb', ['shell', 'settings', 'put', 'system', 'screen_off_timeout', timeout.toString()]);
}

/**
 * Disable Quest proximity sensor (keeps screen on even when not worn)
 */
async function disableProximitySensor(): Promise<void> {
  await execCommand('adb', ['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close']);
}

/**
 * Enable Quest proximity sensor (re-enable normal behavior)
 * Note: automation_disable actually RE-ENABLES normal proximity sensor automation
 */
async function enableProximitySensor(): Promise<void> {
  await execCommand('adb', ['shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.automation_disable']);
}

/**
 * Wake the Quest screen
 */
async function wakeScreen(): Promise<void> {
  await execCommand('adb', ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
}

/**
 * Child watchdog process - polls for parent death and cleans up
 */
export async function stayAwakeWatchdog(parentPid: number, originalTimeout: number): Promise<void> {
  const pollInterval = 5000; // Check every 5 seconds

  const checkParent = setInterval(() => {
    try {
      // Check if parent process still exists
      process.kill(parentPid, 0);
      // Parent still alive, continue polling
    } catch {
      // Parent is dead - perform cleanup
      console.log('Parent process died, restoring Quest settings...');
      clearInterval(checkParent);

      // Restore settings synchronously
      try {
        execSync(`adb shell settings put system screen_off_timeout ${originalTimeout}`, { stdio: 'ignore' });
        execSync(`adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable`, { stdio: 'ignore' });

        // Cleanup PID file
        const pidFile = `${os.homedir()}/.quest-dev-stay-awake.pid`;
        try {
          fs.unlinkSync(pidFile);
        } catch {}

        console.log(`Screen timeout restored to ${originalTimeout}ms (${Math.round(originalTimeout / 1000)}s)`);
        console.log('Proximity sensor re-enabled');
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
export async function stayAwakeCommand(idleTimeout: number = 300000): Promise<void> {
  // Check prerequisites
  checkADBPath();

  // Check devices without verbose output
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

  // PID file management
  const pidFilePath = `${os.homedir()}/.quest-dev-stay-awake.pid`;

  // Check for existing process
  if (fs.existsSync(pidFilePath)) {
    const existingPid = parseInt(fs.readFileSync(pidFilePath, 'utf-8'));
    try {
      process.kill(existingPid, 0); // Test if process exists
      console.error(`Error: stay-awake is already running (PID: ${existingPid})`);
      process.exit(1);
    } catch {
      // Process dead, cleanup stale PID file
      fs.unlinkSync(pidFilePath);
    }
  }

  // Get original timeout
  let originalTimeout: number;

  try {
    originalTimeout = await getScreenTimeout();
    console.log(`Original screen timeout: ${originalTimeout}ms (${Math.round(originalTimeout / 1000)}s)`);
  } catch (error) {
    console.error('Failed to get current screen timeout');
    process.exit(1);
  }

  // Write PID file
  try {
    fs.writeFileSync(pidFilePath, process.pid.toString());
  } catch (error) {
    console.warn('Failed to write PID file, hook will not work');
  }

  // Spawn child watchdog process
  let childProcess: ChildProcess | null = null;
  try {
    childProcess = spawn(process.execPath, [
      process.argv[1], // quest-dev script path
      'stay-awake-watchdog',
      '--parent-pid', process.pid.toString(),
      '--original-timeout', originalTimeout.toString()
    ], {
      detached: true,
      stdio: 'ignore'
    });

    childProcess.unref(); // Allow parent to exit without waiting for child
  } catch (error) {
    console.warn('Failed to spawn watchdog child process');
  }

  // Wake screen and disable proximity sensor
  try {
    await wakeScreen();
    console.log('Quest screen woken up');

    await disableProximitySensor();
    console.log('Proximity sensor disabled');
  } catch (error) {
    console.error('Failed to wake screen or disable proximity sensor:', (error as Error).message);
  }

  // Set timeout to 24 hours (86400000ms)
  const longTimeout = 86400000;
  try {
    await setScreenTimeout(longTimeout);
    console.log(`Screen timeout set to 24 hours`);
    console.log(`Quest will stay awake (idle timeout: ${Math.round(idleTimeout / 1000)}s). Press Ctrl-C to restore original settings.`);
  } catch (error) {
    console.error('Failed to set screen timeout');
    process.exit(1);
  }

  // Idle timer mechanism
  let idleTimerHandle: NodeJS.Timeout | null = null;
  let cleanupInProgress = false;

  const resetIdleTimer = () => {
    if (idleTimerHandle) clearTimeout(idleTimerHandle);
    idleTimerHandle = setTimeout(() => {
      console.log('\nIdle timeout reached, exiting...');
      cleanup();
    }, idleTimeout);
  };

  // Set up cleanup on exit (must be synchronous for signal handlers)
  const cleanup = () => {
    if (cleanupInProgress) return; // Guard against double-cleanup
    cleanupInProgress = true;

    // Clear idle timer
    if (idleTimerHandle) clearTimeout(idleTimerHandle);

    // Kill child watchdog
    if (childProcess) {
      try {
        childProcess.kill();
      } catch {}
    }

    console.log('\nRestoring original settings...');
    try {
      // Remove PID file
      try {
        fs.unlinkSync(pidFilePath);
      } catch {}

      // Restore Quest settings
      execSync(`adb shell settings put system screen_off_timeout ${originalTimeout}`, { stdio: 'ignore' });
      execSync(`adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable`, { stdio: 'ignore' });
      console.log(`Screen timeout restored to ${originalTimeout}ms (${Math.round(originalTimeout / 1000)}s)`);
      console.log(`Proximity sensor re-enabled`);
    } catch (error) {
      console.error('Failed to restore settings:', (error as Error).message);
    }
    process.exit(0);
  };

  // Handle Ctrl-C and termination
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  // Handle SIGUSR1 for activity reset
  process.on('SIGUSR1', () => {
    console.log('Activity detected, resetting idle timer');
    resetIdleTimer();
  });

  // Start idle timer
  resetIdleTimer();

  // Keep process running with an interval that does nothing
  console.log('Keeping Quest awake...');
  setInterval(() => {
    // Do nothing, just keep process alive
  }, 60000); // Check every minute

  // Prevent process from exiting
  await new Promise<void>((resolve) => {
    // This will only resolve when cleanup is called
    process.on('exit', () => resolve());
  });
}
