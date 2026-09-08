import { describe, it, expect, vi } from 'vitest';
import { waitForPanelComposited } from '../src/utils/adb.js';

// waitForPanelComposited used to call the real `adb` binary for every probe,
// which is why no test could reach it. It now takes the same AdbExecRunner
// deploy() injects; stub the exec module so a regression that goes back to
// spawning adb resolves undefined and blows up here rather than on a device.
vi.mock('../src/utils/exec.js');

const task = (flags: string) =>
  `    * Task{7a80656 #19817 type=standard A=10064:net.monoloco.chromium U=0 rootTaskId=19816 ${flags} sz=1}`;

const runner = (dumpsys: string, power = 'mWakefulness=Awake', logcat = '') =>
  vi.fn(async (args: string[]) => {
    const cmd = args.join(' ');
    if (cmd.includes('dumpsys activity activities')) return { stdout: dumpsys, stderr: '', code: 0 };
    if (cmd.includes('dumpsys power')) return { stdout: power, stderr: '', code: 0 };
    if (cmd.includes('logcat')) return { stdout: logcat, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });

const fast = { tries: 1, timeoutMs: 0, pollMs: 0 };

describe('waitForPanelComposited', () => {
  it('passes on a composited panel, using only the injected runner', async () => {
    const adb = runner(task('visible=true visibleRequested=true'));
    expect(await waitForPanelComposited('net.monoloco.chromium', { ...fast, adb })).toEqual({ ok: true });
    expect(adb).toHaveBeenCalled();
  });

  it('blames the sleeping display when the panel never composites', async () => {
    const adb = runner(task('visible=true visibleRequested=false'), 'mWakefulness=Asleep');
    const result = await waitForPanelComposited('net.monoloco.chromium', { ...fast, adb });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('display is asleep') });
  });

  it('reports the VR shell reason when the panel is backgrounded while awake', async () => {
    const adb = runner(
      task('visible=false visibleRequested=false'),
      'mWakefulness=Awake',
      'I [SEO] PanelAppHost: Panel (panelId:36) (net.monoloco.chromium/x) is now backgrounded due to: guardian',
    );
    const result = await waitForPanelComposited('net.monoloco.chromium', { ...fast, adb });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('backgrounded due to: guardian') });
  });
});
