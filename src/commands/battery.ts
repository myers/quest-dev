/**
 * Quest battery command
 * Shows battery percentage and charging status
 */

import { checkADBPath, checkADBDevices, getBatteryStatus } from '../utils/adb.js';

/**
 * Main battery command handler
 */
export async function batteryCommand(): Promise<void> {
  // Check prerequisites (silent)
  checkADBPath();

  // Check devices without verbose output
  try {
    const { execCommand } = await import('../utils/exec.js');
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

  // Get and display battery status
  const status = await getBatteryStatus();
  console.log(status);
}
