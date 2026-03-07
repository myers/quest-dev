/**
 * ADB utilities for Quest device communication
 */

import which from 'which';
import net from 'net';
import { execCommand, execCommandFull } from './exec.js';
import { verbose } from './verbose.js';

const CDP_PORT = 9223; // Chrome DevTools Protocol port (Quest browser default)

/**
 * Get browser process PID
 */
async function getBrowserPID(packageName: string): Promise<number | null> {
  try {
    const result = await execCommandFull('adb', ['shell', `ps | grep ${packageName}`]);
    verbose('getBrowserPID ps output:', result.stdout?.trim());
    if (!result.stdout) return null;

    // Parse ps output: USER PID PPID ... NAME
    // Only match the main process (exact package name at end of line), not
    // child processes like :sandboxed_process0 or :privileged_process0
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      if (line.includes('grep')) continue; // Skip grep itself
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        // Check that the process name is exactly the package (last column)
        const processName = parts[parts.length - 1];
        if (processName === packageName) {
          const pid = parseInt(parts[1], 10);
          verbose('getBrowserPID found PID:', pid, 'for', packageName);
          return pid;
        }
      }
    }
    verbose('getBrowserPID: no exact match for', packageName);
  } catch (e) {
    verbose('getBrowserPID error:', e);
    return null;
  }
  return null;
}

/**
 * Detect CDP socket for a browser
 * Returns socket name (e.g., "chrome_devtools_remote_12345")
 */
async function detectCDPSocket(packageName: string): Promise<string> {
  const pid = await getBrowserPID(packageName);

  if (pid) {
    // Try PID-based socket, with retries (socket may take a moment to appear)
    const socketName = `chrome_devtools_remote_${pid}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await execCommandFull('adb', [
          'shell',
          `cat /proc/net/unix | grep ${socketName}`
        ]);
        if (result.stdout.includes(socketName)) {
          verbose('detectCDPSocket: found PID-specific socket:', socketName, `(attempt ${attempt + 1})`);
          return socketName;
        }
      } catch {
        // ignore
      }
      if (attempt < 4) {
        verbose('detectCDPSocket: PID-specific socket not found yet, retrying in 1s...', `(attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    verbose('detectCDPSocket: PID-specific socket not found after retries:', socketName);
  }

  // Default: generic socket (Quest Browser)
  verbose('detectCDPSocket: falling back to generic chrome_devtools_remote');
  return 'chrome_devtools_remote';
}

/**
 * Get CDP port for a socket.
 * Always use 9223 regardless of socket type for consistency.
 */
function getCDPPortForSocket(_socket: string): number {
  return CDP_PORT;
}

/**
 * Check if ADB is available on PATH
 */
export function checkADBPath(): string {
  try {
    const adbPath = which.sync('adb');
    return adbPath;
  } catch (error) {
    console.error('Error: ADB not found in PATH');
    console.error('');
    console.error('Please install Android Platform Tools and add adb to your PATH:');
    console.error('https://developer.android.com/tools/releases/platform-tools');
    console.error('');
    console.error('Installation instructions:');
    console.error('- macOS: brew install android-platform-tools');
    console.error('- Linux: sudo apt install adb (or equivalent)');
    console.error('- Windows: Download from the link above and add to PATH');
    console.error('');
    process.exit(1);
  }
}

/**
 * Restart ADB server if it's in a bad state
 */
async function restartADBServer(): Promise<boolean> {
  console.log('ADB server appears to be in a bad state, restarting...');
  try {
    // Kill server (ignore errors - it might already be dead)
    await execCommandFull('adb', ['kill-server']);
    // Start server
    await execCommand('adb', ['start-server']);
    console.log('ADB server restarted successfully');
    return true;
  } catch (error) {
    console.error('Failed to restart ADB server:', (error as Error).message);
    return false;
  }
}

/**
 * Check if ADB devices are connected (with auto-recovery for server issues)
 */
export async function checkADBDevices(retryCount = 0): Promise<boolean> {
  try {
    const output = await execCommand('adb', ['devices']);
    const lines = output.trim().split('\n').slice(1); // Skip header
    const devices = lines.filter(line => line.trim() && !line.includes('List of devices'));

    if (devices.length === 0) {
      console.error('Error: No ADB devices connected');
      console.error('');
      console.error('Please connect your Quest device via USB and enable USB debugging');
      console.error('');
      process.exit(1);
    }

    console.log(`Found ${devices.length} ADB device(s)`);
    return true;
  } catch (error) {
    const errorMsg = (error as Error).message;
    // Check if it's a server issue
    const isServerIssue = errorMsg.includes('protocol fault') ||
                         errorMsg.includes('Connection reset') ||
                         errorMsg.includes('server version') ||
                         errorMsg.includes('cannot connect to daemon');

    if (isServerIssue && retryCount === 0) {
      const restarted = await restartADBServer();
      if (restarted) {
        return await checkADBDevices(1);
      }
    }

    console.error('Error: Failed to list ADB devices:', errorMsg);
    console.error('');
    console.error('Try running: adb kill-server && adb start-server');
    console.error('');
    process.exit(1);
  }
}

/**
 * Check if a port is already listening on localhost
 */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Idempotently set up ADB port forwarding for a given port
 */
export async function ensurePortForwarding(
  port: number,
  browser: string = 'com.oculus.browser'
): Promise<void> {
  try {
    // Detect CDP socket and port for this browser
    const cdpSocket = await detectCDPSocket(browser);
    const cdpPort = getCDPPortForSocket(cdpSocket);

    // Check reverse forwarding (Quest -> Host for dev server)
    const reverseList = await execCommand('adb', ['reverse', '--list']);
    const reverseExists = reverseList.includes(`tcp:${port}`);

    if (reverseExists) {
      console.log(`ADB reverse port forwarding already set up: Quest:${port} -> Host:${port}`);
    } else {
      await execCommand('adb', ['reverse', `tcp:${port}`, `tcp:${port}`]);
      console.log(`ADB reverse port forwarding set up: Quest:${port} -> Host:${port}`);
    }

    // Check forward forwarding (Host -> Quest for CDP)
    // First check if ADB already has this forwarding set up
    const forwardList = await execCommand('adb', ['forward', '--list']);
    const forwardExists = forwardList.includes(`tcp:${cdpPort}`) && forwardList.includes(cdpSocket);

    if (forwardExists) {
      console.log(`CDP port ${cdpPort} forwarding already set up`);
    } else {
      // Check if something else is using the port
      const cdpPortListening = await isPortListening(cdpPort);
      if (cdpPortListening) {
        console.error(`Error: Port ${cdpPort} is already in use by another process`);
        console.error('');
        console.error(`CDP port forwarding requires port ${cdpPort} to be free.`);
        console.error('Please stop the process using this port and try again.');
        console.error('');
        console.error('To find what is using the port:');
        console.error(`  lsof -i :${cdpPort}`);
        console.error('');
        process.exit(1);
      }

      await execCommand('adb', ['forward', `tcp:${cdpPort}`, `localabstract:${cdpSocket}`]);
      console.log(`ADB forward port forwarding set up: Host:${cdpPort} -> Quest:${cdpSocket} (CDP)`);
    }
  } catch (error) {
    console.error('Failed to set up port forwarding:', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Check if browser is running
 */
export async function isBrowserRunning(browser: string = 'com.oculus.browser'): Promise<boolean> {
  try {
    const result = await execCommandFull('adb', ['shell', `ps | grep ${browser}`]);
    verbose('isBrowserRunning ps output:', result.stdout?.trim());
    // Check for exact process name match (not _zygote or :sandboxed_process)
    const lines = result.stdout?.trim().split('\n') || [];
    for (const line of lines) {
      if (line.includes('grep')) continue;
      const parts = line.trim().split(/\s+/);
      const processName = parts[parts.length - 1];
      if (processName === browser) {
        verbose('isBrowserRunning:', browser, 'YES (PID', parts[1] + ')');
        return true;
      }
    }
    verbose('isBrowserRunning:', browser, 'NO (zygote/child only)');
    return false;
  } catch (error) {
    verbose('isBrowserRunning error:', error);
    return false;
  }
}

/**
 * Launch browser with a URL using am start
 */
export async function launchBrowser(url: string, browser: string = 'com.oculus.browser'): Promise<boolean> {
  console.log('Launching browser...');
  try {
    await execCommand('adb', [
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      url,
      browser
    ]);
    console.log(`Browser launched with URL: ${url}`);
    return true;
  } catch (error) {
    console.error('Failed to launch browser:', (error as Error).message);
    return false;
  }
}

/**
 * Get CDP port
 */
export async function getCDPPort(browser: string = 'com.oculus.browser'): Promise<number> {
  const cdpSocket = await detectCDPSocket(browser);
  return getCDPPortForSocket(cdpSocket);
}

/**
 * Set up only CDP forwarding (for external URLs that don't need reverse forwarding)
 */
export async function ensureCDPForwarding(
  browser: string = 'com.oculus.browser'
): Promise<void> {
  try {
    // Detect CDP socket and port for this browser
    const cdpSocket = await detectCDPSocket(browser);
    const cdpPort = getCDPPortForSocket(cdpSocket);

    // Check forward forwarding (Host -> Quest for CDP)
    const forwardList = await execCommand('adb', ['forward', '--list']);
    const forwardExists = forwardList.includes(`tcp:${cdpPort}`) && forwardList.includes(cdpSocket);

    if (forwardExists) {
      console.log(`CDP port ${cdpPort} forwarding already set up`);
    } else {
      // Check if something else is using the port
      const cdpPortListening = await isPortListening(cdpPort);
      if (cdpPortListening) {
        console.error(`Error: Port ${cdpPort} is already in use by another process`);
        console.error('');
        console.error(`CDP port forwarding requires port ${cdpPort} to be free.`);
        console.error('Please stop the process using this port and try again.');
        console.error('');
        console.error('To find what is using the port:');
        console.error(`  lsof -i :${cdpPort}`);
        console.error('');
        process.exit(1);
      }

      await execCommand('adb', ['forward', `tcp:${cdpPort}`, `localabstract:${cdpSocket}`]);
      console.log(`ADB forward port forwarding set up: Host:${cdpPort} -> Quest:${cdpSocket} (CDP)`);
    }
  } catch (error) {
    console.error('Failed to set up CDP forwarding:', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Re-detect CDP socket after browser launch and update forwarding if needed.
 * This handles the case where the initial forwarding used the generic socket
 * (before the browser had a PID), but the browser created a PID-specific socket.
 */
export async function refreshCDPForwarding(
  browser: string = 'com.oculus.browser'
): Promise<void> {
  try {
    const cdpSocket = await detectCDPSocket(browser);
    const cdpPort = getCDPPortForSocket(cdpSocket);

    // Check if forwarding already points to the correct socket
    const forwardList = await execCommand('adb', ['forward', '--list']);
    verbose('refreshCDPForwarding: detected socket:', cdpSocket, 'port:', cdpPort);
    verbose('refreshCDPForwarding: current forwards:', forwardList.trim());

    // Check exact match: the forward line must end with the exact socket name
    const expectedForward = `tcp:${cdpPort} localabstract:${cdpSocket}`;
    if (forwardList.includes(expectedForward)) {
      verbose('refreshCDPForwarding: forwarding already correct');
      return; // Already correct
    }

    // Remove existing forwarding on CDP port and re-create with correct socket
    if (forwardList.includes(`tcp:${cdpPort}`)) {
      verbose('refreshCDPForwarding: removing stale forwarding on port', cdpPort);
      await execCommandFull('adb', ['forward', '--remove', `tcp:${cdpPort}`]);
    }

    await execCommand('adb', ['forward', `tcp:${cdpPort}`, `localabstract:${cdpSocket}`]);
    console.log(`CDP forwarding updated: Host:${cdpPort} -> Quest:${cdpSocket}`);
  } catch (error) {
    // Non-fatal: CDP may still work with existing forwarding
    console.log('Warning: Could not refresh CDP forwarding:', (error as Error).message);
  }
}

/**
 * Check if USB file transfer is authorized on Quest
 * After reboot, user must click notification to allow file access
 */
export async function checkUSBFileTransfer(): Promise<void> {
  const result = await execCommandFull('adb', ['shell', 'ls', '/sdcard/']);

  if (result.code !== 0 ||
      result.stdout.includes('Permission denied') ||
      result.stderr.includes('Permission denied')) {
    console.error('Error: USB file transfer not authorized on Quest');
    console.error('');
    console.error('After rebooting your Quest, you need to authorize USB file transfers:');
    console.error('1. Put on your Quest headset');
    console.error('2. Look for the "Allow access to data" notification');
    console.error('3. Click "Allow" to authorize file transfers');
    console.error('');
    process.exit(1);
  }
}

/**
 * Check if Quest display is awake
 * Screenshots cannot be taken when the display is off
 */
export async function checkQuestAwake(): Promise<void> {
  const result = await execCommandFull('adb', ['shell', 'dumpsys', 'power']);

  if (result.stdout.includes('mWakefulness=Asleep')) {
    console.error('Error: Quest display is off');
    console.error('');
    console.error('Put on the Quest headset or press the power button to wake it.');
    console.error('');
    process.exit(1);
  }
}

export interface BatteryInfo {
  level: number;
  state: 'fast charging' | 'charging' | 'not charging';
}

/**
 * Get Quest battery info as structured data
 */
export async function getBatteryInfo(): Promise<BatteryInfo> {
  const result = await execCommandFull('adb', ['shell', 'dumpsys', 'battery']);

  if (result.code !== 0) {
    throw new Error('Failed to get battery status');
  }

  let level = 0;
  let acPowered = false;
  let usbPowered = false;
  let maxChargingCurrent = 0;

  const lines = result.stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('level: ')) {
      level = parseInt(trimmed.substring(7), 10);
    } else if (trimmed.startsWith('AC powered: ')) {
      acPowered = trimmed.substring(12) === 'true';
    } else if (trimmed.startsWith('USB powered: ')) {
      usbPowered = trimmed.substring(13) === 'true';
    } else if (trimmed.startsWith('Max charging current: ')) {
      maxChargingCurrent = parseInt(trimmed.substring(22), 10);
    }
  }

  let state: BatteryInfo['state'];
  if (acPowered || usbPowered) {
    state = maxChargingCurrent > 2000000 ? 'fast charging' : 'charging';
  } else {
    state = 'not charging';
  }

  return { level, state };
}

/**
 * Format battery info as a human-readable string
 */
export function formatBatteryInfo(info: BatteryInfo): string {
  return `${info.level}% ${info.state}`;
}
