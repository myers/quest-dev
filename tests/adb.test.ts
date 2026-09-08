import { describe, it, expect } from 'vitest';
import { isPortListening, getCDPPort, firstFreePort, devtoolsForwards, resolveCdpPort, parsePanelState, parseBackgroundReason } from '../src/utils/adb.js';
import { cdpPortForSerial } from '../src/utils/device-id.js';
import net from 'net';

describe('isPortListening', () => {
  it('should return false for a port that is not listening', async () => {
    // Use a high port number unlikely to be in use
    const result = await isPortListening(59999);
    expect(result).toBe(false);
  });

  it('should return true for a port that is listening', async () => {
    // Create a temporary server
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as net.AddressInfo;
    const port = address.port;

    const result = await isPortListening(port);
    expect(result).toBe(true);

    // Clean up
    server.close();
  });
});

describe('getCDPPort', () => {
  it('should return the default CDP port', async () => {
    const port = await getCDPPort();
    expect(port).toBe(9223);
  });
});

describe('firstFreePort', () => {
  it('returns the preferred port when the probe says it is free', async () => {
    const p = await firstFreePort(9230, async () => true);
    expect(p).toBe(9230);
  });
  it('probes upward until a free port is found', async () => {
    const taken = new Set([9230, 9231]);
    const p = await firstFreePort(9230, async (port) => !taken.has(port));
    expect(p).toBe(9232);
  });
});

describe('devtoolsForwards', () => {
  const list = [
    '2G0YC1ZF7V0HP1 tcp:9249 localabstract:chrome_devtools_remote_4083',
    '1WMHHA1234567 tcp:9260 localabstract:chrome_devtools_remote',
  ].join('\n');

  it('parses every device\'s devtools forwards', () => {
    expect(devtoolsForwards(list)).toEqual([
      { serial: '2G0YC1ZF7V0HP1', port: 9249 },
      { serial: '1WMHHA1234567', port: 9260 },
    ]);
  });

  it('ignores forwards that are not devtools sockets', () => {
    expect(devtoolsForwards('2G0YC1ZF7V0HP1 tcp:9249 localabstract:something_else')).toEqual([]);
  });

  it('returns nothing for an empty list', () => {
    expect(devtoolsForwards('')).toEqual([]);
  });
});

describe('resolveCdpPort', () => {
  const QUEST3 = '2G0YC1ZF7V0HP1';
  // cdpPortForSerial is a hash; assert the fixtures line up with it so the
  // "9249" in these lists means "this device's deterministic port".
  it('fixture serial hashes to 9249', () => {
    expect(cdpPortForSerial(QUEST3)).toBe(9249);
  });

  // The leak (iss 28f5eb0): adb listens on its own forwarded port, so probing
  // for a free port walks past it and allocates a new forward every call.
  it('reuses the existing forward instead of probing past it', async () => {
    const listed = '2G0YC1ZF7V0HP1 tcp:9249 localabstract:chrome_devtools_remote_4083';
    const port = await resolveCdpPort(
      '2G0YC1ZF7V0HP1',
      async (p) => p !== 9249, // 9249 "in use" — adb is listening on it
      async () => listed,
    );
    expect(port).toBe(9249);
  });

  // iss 405ee1d: adb does not sort `forward --list`, so a first-match pick
  // returned whichever stale forward adb happened to print first.
  it('picks the deterministic port no matter where it sits in the list', async () => {
    const leaked = [
      '2G0YC1ZF7V0HP1 tcp:9250 localabstract:chrome_devtools_remote_30901',
      '2G0YC1ZF7V0HP1 tcp:9262 localabstract:chrome_devtools_remote_5045',
      '2G0YC1ZF7V0HP1 tcp:9249 localabstract:chrome_devtools_remote_30231',
      '2G0YC1ZF7V0HP1 tcp:9251 localabstract:chrome_devtools_remote_7279',
    ].join('\n');
    for (const list of [leaked, leaked.split('\n').reverse().join('\n')]) {
      expect(await resolveCdpPort(QUEST3, async () => false, async () => list)).toBe(9249);
    }
  });

  // The VR shell owns a real bare `chrome_devtools_remote`; a forward to it on
  // our port is another app's socket, not a reason to move ports.
  it('keeps the deterministic port when it forwards the VR shell\'s bare socket', async () => {
    const port = await resolveCdpPort(
      QUEST3,
      async () => false,
      async () => '2G0YC1ZF7V0HP1 tcp:9249 localabstract:chrome_devtools_remote',
    );
    expect(port).toBe(9249);
  });

  it('yields the deterministic port to the device that owns it, reusing its own lowest forward', async () => {
    const list = [
      '1WMHHA1234567 tcp:9249 localabstract:chrome_devtools_remote_4083',
      '2G0YC1ZF7V0HP1 tcp:9262 localabstract:chrome_devtools_remote_5045',
      '2G0YC1ZF7V0HP1 tcp:9251 localabstract:chrome_devtools_remote_7279',
    ].join('\n');
    expect(await resolveCdpPort(QUEST3, async () => false, async () => list)).toBe(9251);
  });

  it('probes upward when another device owns the port and we have no forward', async () => {
    const list = '1WMHHA1234567 tcp:9249 localabstract:chrome_devtools_remote_4083';
    const port = await resolveCdpPort(QUEST3, async (p) => p > 9249, async () => list);
    expect(port).toBe(9250);
  });

  it('probes from the preferred port when the device has no forward yet', async () => {
    const port = await resolveCdpPort('2G0YC1ZF7V0HP1', async () => true, async () => '');
    expect(port).toBe(cdpPortForSerial('2G0YC1ZF7V0HP1'));
  });

  it('falls back to probing when adb forward --list fails', async () => {
    const port = await resolveCdpPort(
      '2G0YC1ZF7V0HP1',
      async () => true,
      async () => { throw new Error('adb: device offline'); },
    );
    expect(port).toBe(cdpPortForSerial('2G0YC1ZF7V0HP1'));
  });
});

describe('parsePanelState', () => {
  // Real `dumpsys activity activities` task lines from a Quest 3 (2G0YC1ZF7V0HP1).
  const task = (flags: string) =>
    `    * Task{7a80656 #19817 type=standard A=10064:net.monoloco.chromium U=0 rootTaskId=19816 ${flags} mode=multi-window translucent=false sz=1}`;

  it('reads a composited panel', () => {
    expect(parsePanelState(task('visible=true visibleRequested=true'), 'net.monoloco.chromium'))
      .toBe('composited');
  });

  it('reads a panel the VR shell backgrounded', () => {
    expect(parsePanelState(task('visible=false visibleRequested=false'), 'net.monoloco.chromium'))
      .toBe('not-composited');
  });

  // The trap: launched onto a sleeping display, no panel ever created, yet
  // visible=true. Half-reading the line calls this composited.
  it('does not call a sleeping display composited', () => {
    expect(parsePanelState(task('visible=true visibleRequested=false'), 'net.monoloco.chromium'))
      .toBe('not-composited');
  });

  it('reports no-task when the package has no activity task', () => {
    expect(parsePanelState(task('visible=true visibleRequested=true'), 'com.oculus.browser'))
      .toBe('no-task');
  });
});

describe('parseBackgroundReason', () => {
  // Verbatim lines from ~/.local/state/quest-dev/logcat/2G0YC1ZF7V0HP1/.
  const log = [
    '09-07 16:31:08.030  2903  3215 I [SEO] PanelAppHost: Panel (panelId:36) (net.monoloco.chromium/org.chromium.chrome.browser.ChromeTabbedActivity) is now backgrounded due to: guardian',
    '09-08 11:45:14.492  2903  3215 I [SEO] PanelAppHost: Panel app (panelId:300) (net.monoloco.chromium/org.chromium.chrome.browser.ChromeTabbedActivity) changing state from startup to foreground',
    '09-08 11:45:23.672  2903  3215 I [SEO] PanelAppHost: Panel (panelId:300) (net.monoloco.chromium/org.chromium.chrome.browser.ChromeTabbedActivity) is now backgrounded due to: egoCentricDesktopBackground',
  ].join('\n');

  it('returns the most recent reason for the package', () => {
    expect(parseBackgroundReason(log, 'net.monoloco.chromium')).toBe('egoCentricDesktopBackground');
  });

  it('ignores other packages', () => {
    expect(parseBackgroundReason(log, 'com.oculus.browser')).toBeNull();
  });

  it('returns null when the shell logged no reason', () => {
    expect(parseBackgroundReason('', 'net.monoloco.chromium')).toBeNull();
  });
});
