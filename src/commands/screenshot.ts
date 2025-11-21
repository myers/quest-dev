/**
 * Quest screenshot command
 * Triggers Quest's native screenshot service and pulls the file
 */

import { resolve } from 'path';
import { checkADBPath, checkADBDevices } from '../utils/adb.js';
import { execCommand } from '../utils/exec.js';

/**
 * Trigger Quest screenshot service
 */
async function triggerScreenshot(): Promise<boolean> {
  try {
    await execCommand('adb', [
      'shell',
      'am',
      'startservice',
      '-n',
      'com.oculus.metacam/.capture.CaptureService',
      '-a',
      'TAKE_SCREENSHOT'
    ]);
    console.log('Screenshot service triggered');
    return true;
  } catch (error) {
    console.error('Failed to trigger screenshot:', (error as Error).message);
    return false;
  }
}

/**
 * Get most recent screenshot filename from Quest
 */
async function getMostRecentScreenshot(): Promise<string | null> {
  try {
    const output = await execCommand('adb', ['shell', 'ls', '-t', '/sdcard/Oculus/Screenshots/']);
    const files = output.split('\n').filter(line => line.trim() && line.endsWith('.jpg'));

    if (files.length === 0) {
      console.error('No screenshots found in /sdcard/Oculus/Screenshots/');
      return null;
    }

    const mostRecent = files[0].trim();
    console.log(`Found most recent screenshot: ${mostRecent}`);
    return mostRecent;
  } catch (error) {
    console.error('Failed to list screenshots:', (error as Error).message);
    return null;
  }
}

/**
 * Pull screenshot from Quest to local path
 */
async function pullScreenshot(filename: string, outputPath: string): Promise<boolean> {
  try {
    const remotePath = `/sdcard/Oculus/Screenshots/${filename}`;
    await execCommand('adb', ['pull', remotePath, outputPath]);
    console.log(`Screenshot saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error('Failed to pull screenshot:', (error as Error).message);
    return false;
  }
}

/**
 * Main screenshot command handler
 */
export async function screenshotCommand(outputPath: string): Promise<void> {
  const resolvedPath = resolve(outputPath);

  console.log('\nQuest Screenshot\n');

  // Check prerequisites
  checkADBPath();
  await checkADBDevices();

  // Trigger screenshot
  if (!await triggerScreenshot()) {
    process.exit(1);
  }

  // Wait for screenshot to save
  console.log('Waiting for screenshot to save...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Get most recent screenshot
  const filename = await getMostRecentScreenshot();
  if (!filename) {
    process.exit(1);
  }

  // Pull screenshot
  if (!await pullScreenshot(filename, resolvedPath)) {
    process.exit(1);
  }

  console.log('\nDone!\n');
}
