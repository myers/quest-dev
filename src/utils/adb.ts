/**
 * ADB utilities for Quest device communication
 */

import which from 'which';
import net from 'net';
import { execCommand, execCommandFull } from './exec.js';

const CDP_PORT = 9223; // Chrome DevTools Protocol port (Quest browser default)

/**
 * Check if ADB is available on PATH
 */
export function checkADBPath(): string {
  try {
    const adbPath = which.sync('adb');
    console.log(`Found ADB at: ${adbPath}`);
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
export async function ensurePortForwarding(port: number): Promise<void> {
  try {
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
    const forwardExists = forwardList.includes(`tcp:${CDP_PORT}`) && forwardList.includes('chrome_devtools_remote');

    if (forwardExists) {
      console.log(`CDP port ${CDP_PORT} forwarding already set up`);
    } else {
      // Check if something else is using the port
      const cdpPortListening = await isPortListening(CDP_PORT);
      if (cdpPortListening) {
        console.error(`Error: Port ${CDP_PORT} is already in use by another process`);
        console.error('');
        console.error('CDP port forwarding requires port 9223 to be free.');
        console.error('Please stop the process using this port and try again.');
        console.error('');
        console.error('To find what is using the port:');
        console.error(`  lsof -i :${CDP_PORT}`);
        console.error('');
        process.exit(1);
      }

      await execCommand('adb', ['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote']);
      console.log(`ADB forward port forwarding set up: Host:${CDP_PORT} -> Quest:chrome_devtools_remote (CDP)`);
    }
  } catch (error) {
    console.error('Failed to set up port forwarding:', (error as Error).message);
    process.exit(1);
  }
}

/**
 * Check if Quest browser is running
 */
export async function isBrowserRunning(): Promise<boolean> {
  try {
    const result = await execCommandFull('adb', ['shell', 'ps | grep com.oculus.browser']);
    return result.stdout.includes('com.oculus.browser');
  } catch (error) {
    return false;
  }
}

/**
 * Launch Quest browser with a URL using am start
 */
export async function launchBrowser(url: string): Promise<boolean> {
  console.log('Launching Quest browser...');
  try {
    await execCommand('adb', [
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      url,
      'com.oculus.browser'
    ]);
    console.log(`Quest browser launched with URL: ${url}`);
    return true;
  } catch (error) {
    console.error('Failed to launch Quest browser:', (error as Error).message);
    return false;
  }
}

/**
 * Get CDP port
 */
export function getCDPPort(): number {
  return CDP_PORT;
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
