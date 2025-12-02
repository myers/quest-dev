/**
 * Quest screenshot command
 * Triggers Quest's native screenshot service and pulls the file
 */

import { resolve } from 'path';
import { checkADBPath, checkADBDevices, checkUSBFileTransfer, checkQuestAwake } from '../utils/adb.js';
import { execCommand, execCommandFull } from '../utils/exec.js';

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
      return null;
    }

    return files[0].trim();
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
 * Delete screenshot from Quest after pulling
 */
async function deleteRemoteScreenshot(filename: string): Promise<void> {
  const remotePath = `/sdcard/Oculus/Screenshots/${filename}`;
  const result = await execCommandFull('adb', ['shell', 'rm', remotePath]);
  if (result.code !== 0) {
    console.warn(`Warning: Failed to delete screenshot from Quest: ${filename}`);
  } else {
    console.log(`Deleted screenshot from Quest: ${filename}`);
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
  await checkUSBFileTransfer();
  await checkQuestAwake();

  // Get existing most recent screenshot (to detect if a new one is created)
  const existingScreenshot = await getMostRecentScreenshot();

  // Trigger screenshot
  if (!await triggerScreenshot()) {
    process.exit(1);
  }

  // Wait for screenshot to save and verify a new one was created
  console.log('Waiting for screenshot to save...');
  let filename: string | null = null;
  const maxAttempts = 10;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const newScreenshot = await getMostRecentScreenshot();

    if (newScreenshot && newScreenshot !== existingScreenshot) {
      filename = newScreenshot;
      console.log(`New screenshot created: ${filename}`);
      break;
    }
  }

  if (!filename) {
    console.error('Error: Screenshot was not created');
    console.error('');
    console.error('The screenshot service was triggered but no new screenshot appeared.');
    console.error('This can happen if:');
    console.error('- The Quest is asleep or the screen is off');
    console.error('- The Quest is showing a system dialog');
    console.error('- There is insufficient storage space');
    console.error('');
    process.exit(1);
  }

  // Pull screenshot
  if (!await pullScreenshot(filename, resolvedPath)) {
    process.exit(1);
  }

  // Delete from Quest after successful pull
  await deleteRemoteScreenshot(filename);

  console.log('\nDone!\n');
}
