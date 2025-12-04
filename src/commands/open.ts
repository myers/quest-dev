/**
 * Quest open command
 * Opens a URL in Quest browser with proper ADB port forwarding
 */

import {
  checkADBPath,
  checkADBDevices,
  ensurePortForwarding,
  ensureCDPForwarding,
  isBrowserRunning,
  launchBrowser,
  getCDPPort
} from '../utils/adb.js';
import { execCommand, execCommandFull } from '../utils/exec.js';

/**
 * Try to navigate or reload existing tab via cdp-cli
 */
async function tryNavigateExistingTab(targetUrl: string): Promise<boolean> {
  const cdpPort = getCDPPort();

  try {
    // Get list of tabs using cdp-cli
    const result = await execCommandFull('cdp-cli', ['--cdp-url', `http://localhost:${cdpPort}`, 'tabs']);

    if (result.code !== 0) {
      console.log('cdp-cli tabs command failed, will launch browser directly');
      return false;
    }

    // Parse NDJSON output to find tabs
    const lines = result.stdout.trim().split('\n').filter(line => line.trim());
    const tabs: Array<{ id: string; url: string; title: string }> = [];

    for (const line of lines) {
      try {
        const tab = JSON.parse(line);
        if (tab.id && tab.url !== undefined) {
          tabs.push(tab);
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    // First, check if URL is already open
    const existingTab = tabs.find(tab => tab.url === targetUrl);
    if (existingTab) {
      console.log(`Found existing tab with URL: ${targetUrl}`);

      // Reload the tab
      const reloadResult = await execCommandFull('cdp-cli', [
        '--cdp-url', `http://localhost:${cdpPort}`,
        'go', existingTab.id, 'reload'
      ]);

      if (reloadResult.code === 0) {
        console.log('Reloaded existing tab');
        return true;
      }
    }

    // Second, look for a blank tab to navigate
    const blankTab = tabs.find(tab =>
      tab.url === 'about:blank' ||
      tab.url === 'chrome://newtab/' ||
      tab.url === 'chrome://panel-app-nav/ntp' ||  // Quest New Tab page
      tab.url === ''
    );

    if (blankTab) {
      console.log('Found blank tab, navigating it...');

      const navResult = await execCommandFull('cdp-cli', [
        '--cdp-url', `http://localhost:${cdpPort}`,
        'go', blankTab.id, targetUrl
      ]);

      if (navResult.code === 0) {
        console.log('Navigated blank tab to URL');
        return true;
      }
    }

    return false;
  } catch (error) {
    console.log('CDP operation failed:', (error as Error).message);
    return false;
  }
}

/**
 * Main open command handler
 */
export async function openCommand(url: string): Promise<void> {
  // Parse URL to determine if we need reverse port forwarding
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    console.error('Error: Invalid URL:', url);
    process.exit(1);
  }

  // Determine if this is a localhost URL that needs reverse forwarding
  const isLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
  let port: number | null = null;

  if (isLocalhost) {
    // For localhost, we need a port for reverse forwarding
    if (parsedUrl.port) {
      port = parseInt(parsedUrl.port, 10);
    } else {
      // Use default port based on protocol
      port = parsedUrl.protocol === 'https:' ? 443 : 80;
    }
  }

  console.log(`\nOpening ${url} on Quest...\n`);

  // Check prerequisites
  checkADBPath();
  await checkADBDevices();

  // Set up port forwarding
  if (port !== null) {
    // Localhost URL: need reverse forwarding so Quest can reach the dev server
    await ensurePortForwarding(port);
  } else {
    // External URL: only need CDP forwarding to control the browser
    await ensureCDPForwarding();
  }

  // Check if browser is running
  const browserRunning = await isBrowserRunning();

  if (!browserRunning) {
    console.log('Quest browser is not running');
    await launchBrowser(url);
  } else {
    console.log('Quest browser is already running');

    // Try to navigate existing or blank tab via cdp-cli first
    const navigated = await tryNavigateExistingTab(url);

    if (!navigated) {
      console.log('No existing or blank tab found, opening URL...');
      await launchBrowser(url);
    }
  }

  console.log('\nDone!\n');
}
