/**
 * ADB utilities for Quest device communication
 */

import which from 'which';
import net from 'net';
import { execCommand, execCommandFull } from './exec.js';
import { verbose } from './verbose.js';
import { cdpPortForSerial } from './device-id.js';

const CDP_PORT = 9223; // Chrome DevTools Protocol port (Quest browser default)

/** Escape a string for safe use in adb shell commands. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Global ADB device target. When set, all adb commands use -s <device>. */
let targetDevice: string | undefined;

/** Set the global ADB device target (IP:port or serial). */
export function setAdbDevice(device: string | undefined): void {
  targetDevice = device;
}

/** Get the global ADB device target. */
export function getAdbDevice(): string | undefined {
  return targetDevice;
}

/** Build ADB args with -s <device> prefix when a target device is set. */
export function adbArgs(...args: string[]): string[] {
  if (targetDevice) {
    return ["-s", targetDevice, ...args];
  }
  return args;
}

/**
 * Get browser process PID
 */
async function getBrowserPID(packageName: string): Promise<number | null> {
  try {
    const result = await execCommandFull('adb', adbArgs('shell', 'pidof', shellEscape(packageName)));
    verbose('getBrowserPID pidof output:', result.stdout?.trim());
    if (!result.stdout?.trim()) return null;
    const pid = parseInt(result.stdout.trim().split(/\s+/)[0], 10);
    if (isNaN(pid)) return null;
    verbose('getBrowserPID found PID:', pid, 'for', packageName);
    return pid;
  } catch (e) {
    verbose('getBrowserPID error:', e);
    return null;
  }
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
        const result = await execCommandFull('adb', adbArgs(
          'shell', 'cat', '/proc/net/unix',
        ));
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

/** Regex matching a TCP-style adb target (e.g. "192.168.1.1" or "192.168.1.1:5555"). */
const TCP_DEVICE_REGEX = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/;

/** Returns true if `target` is a TCP-style adb target. */
export function isTcpTarget(target: string): boolean {
  return TCP_DEVICE_REGEX.test(target);
}

/** Parse `adb devices` output into the device-line entries (one per device). */
function parseAdbDevices(output: string): string[] {
  const lines = output.trim().split('\n').slice(1); // Skip header
  return lines.filter(line => line.trim() && !line.includes('List of devices'));
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
    const target = getAdbDevice();
    let output = await execCommand('adb', ['devices']);
    let devices = parseAdbDevices(output);

    // If a target device is configured, check it's in the list
    if (target) {
      let targetOnline = devices.some(line => line.includes(target) && line.includes('device'));

      // TCP target not yet connected — try `adb connect <target>` once.
      if (!targetOnline && isTcpTarget(target)) {
        console.log(`Configured device ${target} not connected, running: adb connect ${target}`);
        const connectResult = await execCommandFull('adb', ['connect', target]);
        if (connectResult.code === 0) {
          output = await execCommand('adb', ['devices']);
          devices = parseAdbDevices(output);
          targetOnline = devices.some(line => line.includes(target) && line.includes('device'));
        }
      }

      if (!targetOnline) {
        console.error(`Error: Configured device ${target} not found or offline`);
        console.error('');
        console.error('Check connection: adb connect ' + target);
        console.error('');
        process.exit(1);
      }
      // Filter to just the target device for the count
      devices = devices.filter(line => line.includes(target));
    }

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

/** Find the first free port at or above `preferred`, using `isFree` to test
 * each candidate. Pure control flow; `isFree` is injected for testing. */
export async function firstFreePort(
  preferred: number,
  isFree: (port: number) => Promise<boolean>,
): Promise<number> {
  let port = preferred;
  for (let i = 0; i < 128; i++, port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port found at or above ${preferred}`);
}

/** Port of an existing `adb forward` from `serial` to a devtools socket, if
 * there is one. `adb forward --list` ignores `-s` and prints every device's
 * forwards as `<serial> tcp:<port> localabstract:<socket>`, so the serial is
 * matched here rather than on the command line. */
export function cdpForwardPort(forwardList: string, serial: string): number | undefined {
  for (const line of forwardList.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+tcp:(\d+)\s+localabstract:(\S*devtools_remote\S*)$/);
    if (m && m[1] === serial) return Number(m[2]);
  }
  return undefined;
}

/** Resolve the actual CDP forward port for a device: reuse the forward this
 * device already has, else start from its deterministic preferred port and
 * probe upward past any in-use port. `isFree` defaults to "nothing is
 * listening on this port".
 *
 * The reuse is what keeps this idempotent: adb itself listens on a forwarded
 * port, so without it every call probes past its own previous forward and
 * creates a new one, leaking one forward per call until the 128-wide probe
 * window is full. */
export async function resolveCdpPort(
  serial: string,
  isFree: (port: number) => Promise<boolean> = async (p) => !(await isPortListening(p)),
  listForwards: () => Promise<string> = () => execCommand('adb', ['forward', '--list']),
): Promise<number> {
  const existing = cdpForwardPort(await listForwards().catch(() => ''), serial);
  if (existing !== undefined) {
    verbose('resolveCdpPort: reusing existing forward on port', existing, 'for', serial);
    return existing;
  }
  return firstFreePort(cdpPortForSerial(serial), isFree);
}

/**
 * Point `tcp:<cdpPort>` at `localabstract:<cdpSocket>`, idempotently.
 *
 * The port is normally already listening, because adb itself listens on every
 * port it forwards -- and `resolveCdpPort()` deliberately reuses this device's
 * existing forward. So "port in use" only means "somebody else's process" when
 * no adb forward owns it; when the owner is a stale forward of ours (the socket
 * name carries the browser's old pid, which changes on every restart), the fix
 * is to re-point it, not to refuse to run. Refusing left `quest-dev open`
 * exiting 1 with "Port 9249 is already in use by another process" after any
 * browser restart, which reads as a host-side port conflict and is not one.
 */
async function ensureCdpForward(cdpSocket: string, cdpPort: number): Promise<void> {
  const forwardList = await execCommand('adb', adbArgs('forward', '--list'));
  if (forwardList.includes(`tcp:${cdpPort} localabstract:${cdpSocket}`)) {
    console.log(`CDP port ${cdpPort} forwarding already set up`);
    return;
  }

  const staleOurs = new RegExp(`tcp:${cdpPort}\\s+localabstract:\\S*devtools_remote`).test(forwardList);
  if (staleOurs) {
    verbose('ensureCdpForward: re-pointing stale forward on port', cdpPort, 'at', cdpSocket);
    await execCommandFull('adb', adbArgs('forward', '--remove', `tcp:${cdpPort}`));
  } else if (await isPortListening(cdpPort)) {
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

  await execCommand('adb', adbArgs('forward', `tcp:${cdpPort}`, `localabstract:${cdpSocket}`));
  console.log(`ADB forward port forwarding set up: Host:${cdpPort} -> Quest:${cdpSocket} (CDP)`);
}

/**
 * Idempotently set up ADB port forwarding for a given port
 */
export async function ensurePortForwarding(
  port: number,
  browser: string = 'com.oculus.browser',
  cdpPortOverride?: number
): Promise<void> {
  try {
    // Detect CDP socket and port for this browser
    const cdpSocket = await detectCDPSocket(browser);
    const cdpPort = cdpPortOverride ?? getCDPPortForSocket(cdpSocket);

    // Check reverse forwarding (Quest -> Host for dev server)
    const reverseList = await execCommand('adb', adbArgs('reverse', '--list'));
    const reverseExists = reverseList.includes(`tcp:${port}`);

    if (reverseExists) {
      console.log(`ADB reverse port forwarding already set up: Quest:${port} -> Host:${port}`);
    } else {
      await execCommand('adb', adbArgs('reverse', `tcp:${port}`, `tcp:${port}`));
      console.log(`ADB reverse port forwarding set up: Quest:${port} -> Host:${port}`);
    }

    await ensureCdpForward(cdpSocket, cdpPort);
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
    const result = await execCommandFull('adb', adbArgs('shell', 'pidof', shellEscape(browser)));
    const running = result.code === 0 && result.stdout.trim().length > 0;
    verbose('isBrowserRunning:', browser, running ? 'YES' : 'NO');
    return running;
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
    await execCommand('adb', adbArgs(
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      url,
      browser
    ));
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
export async function getCDPPort(
  browser: string = 'com.oculus.browser',
  cdpPortOverride?: number
): Promise<number> {
  if (cdpPortOverride !== undefined) return cdpPortOverride;
  const cdpSocket = await detectCDPSocket(browser);
  return getCDPPortForSocket(cdpSocket);
}

/**
 * Set up only CDP forwarding (for external URLs that don't need reverse forwarding)
 */
export async function ensureCDPForwarding(
  browser: string = 'com.oculus.browser',
  cdpPortOverride?: number
): Promise<void> {
  try {
    // Detect CDP socket and port for this browser
    const cdpSocket = await detectCDPSocket(browser);
    const cdpPort = cdpPortOverride ?? getCDPPortForSocket(cdpSocket);

    await ensureCdpForward(cdpSocket, cdpPort);
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
  browser: string = 'com.oculus.browser',
  cdpPortOverride?: number
): Promise<void> {
  try {
    const cdpSocket = await detectCDPSocket(browser);
    const cdpPort = cdpPortOverride ?? getCDPPortForSocket(cdpSocket);

    // Check if forwarding already points to the correct socket
    const forwardList = await execCommand('adb', adbArgs('forward', '--list'));
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
      await execCommandFull('adb', adbArgs('forward', '--remove', `tcp:${cdpPort}`));
    }

    await execCommand('adb', adbArgs('forward', `tcp:${cdpPort}`, `localabstract:${cdpSocket}`));
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
  const result = await execCommandFull('adb', adbArgs('shell', 'ls', '/sdcard/'));

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
  const result = await execCommandFull('adb', adbArgs('shell', 'dumpsys', 'power'));

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

/** Read the device's stable hardware serial (ro.serialno) for the given
 * transport address. Returns the trimmed serial, or throws on failure. */
export async function readSerial(address: string): Promise<string> {
  const result = await execCommandFull('adb', ['-s', address, 'shell', 'getprop', 'ro.serialno']);
  if (result.code !== 0) {
    throw new Error(`Failed to read serial for ${address}`);
  }
  const serial = result.stdout.trim();
  if (!serial) throw new Error(`Empty serial for ${address}`);
  return serial;
}

/**
 * Get Quest battery info as structured data
 */
export async function getBatteryInfo(): Promise<BatteryInfo> {
  const result = await execCommandFull('adb', adbArgs('shell', 'dumpsys', 'battery'));

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

// --- ADB health check ---

const ADB_PROBE_TIMEOUT_MS = 3000;

export type AdbRecoveryVia = 'connect' | 'reconnect' | 'kill-server';

export type AdbHealthStatus =
  | { kind: 'healthy' }
  | { kind: 'recovered'; via: AdbRecoveryVia }
  | { kind: 'failed'; error: string };

export interface AdbHealthEvents {
  onConnecting?: () => void;
  onReconnecting?: () => void;
  onRestartingServer?: () => void;
  onRecovered?: (via: AdbRecoveryVia) => void;
  onFailed?: (error: string) => void;
}

/**
 * Run a single round-trip probe against the connected device.
 * Returns null on success, or an error message on failure (including timeout).
 */
async function probeAdb(): Promise<string | null> {
  const probe = execCommandFull('adb', adbArgs('shell', 'true'));
  const timeout = new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
    setTimeout(() => resolve({ code: 124, stderr: `probe timed out after ${ADB_PROBE_TIMEOUT_MS}ms`, stdout: '' }), ADB_PROBE_TIMEOUT_MS);
  });
  const result = await Promise.race([probe, timeout]);
  if (result.code === 0) return null;
  return result.stderr.trim() || `probe exited ${result.code}`;
}

/**
 * Ensure the connected ADB device responds to a shell probe. If the probe
 * fails, attempt recovery in three stages (TCP-only stages skip for USB):
 *   1. TCP target not in `adb devices`: `adb connect <target>` (first connect).
 *   2. TCP target in `adb devices` but probe failed: `adb disconnect` + `adb connect`.
 *   3. Fallback: `adb kill-server` + `adb start-server`.
 * Reports progress via optional callbacks; healthy path is silent.
 */
export async function ensureAdbHealthy(events?: AdbHealthEvents): Promise<AdbHealthStatus> {
  let lastError = await probeAdb();
  if (lastError === null) return { kind: 'healthy' };

  const target = getAdbDevice();
  const isTcp = target !== undefined && isTcpTarget(target);

  if (isTcp && target) {
    const listOutput = await execCommand('adb', ['devices']).catch(() => '');
    const devices = parseAdbDevices(listOutput);
    const targetListed = devices.some(line => line.includes(target));

    if (!targetListed) {
      events?.onConnecting?.();
      await execCommandFull('adb', ['connect', target]);
      lastError = await probeAdb();
      if (lastError === null) {
        events?.onRecovered?.('connect');
        return { kind: 'recovered', via: 'connect' };
      }
    } else {
      events?.onReconnecting?.();
      await execCommandFull('adb', ['disconnect', target]);
      await execCommandFull('adb', ['connect', target]);
      lastError = await probeAdb();
      if (lastError === null) {
        events?.onRecovered?.('reconnect');
        return { kind: 'recovered', via: 'reconnect' };
      }
    }
  }

  events?.onRestartingServer?.();
  await execCommandFull('adb', ['kill-server']);
  await execCommandFull('adb', ['start-server']);
  lastError = await probeAdb();
  if (lastError === null) {
    events?.onRecovered?.('kill-server');
    return { kind: 'recovered', via: 'kill-server' };
  }

  const message = lastError ?? 'ADB unresponsive';
  events?.onFailed?.(message);
  return { kind: 'failed', error: message };
}
