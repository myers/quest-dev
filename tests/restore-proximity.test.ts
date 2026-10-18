import { describe, it, expect, vi, beforeEach } from 'vitest';

// Restoring protections must hand proximity back to the sensor. Without
// `automation_disable`, Horizon OS keeps a ~21-day forced "not worn" lock and
// the headset shows black and sleeps after ~15 s on every power-on.
const execCommandFull = vi.fn();
const execFileSync = vi.fn();
vi.mock('../src/utils/exec.js', () => ({ execCommandFull }));
vi.mock('node:child_process', () => ({ execFileSync }));

const { setQuestProtections, restoreProtectionsSync } = await import('../src/utils/quest-protections.js');

const ok = { stdout: 'Bundle[{Success=true}]', stderr: '', code: 0 };
const sentAutomationDisable = (calls: unknown[][]) =>
  calls.some(([, args]) => (args as string[]).includes('com.oculus.vrpowermanager.automation_disable'));

describe('restoring protections releases forced proximity', () => {
  beforeEach(() => {
    execCommandFull.mockReset().mockResolvedValue(ok);
    execFileSync.mockReset().mockReturnValue('Bundle[{Success=true}]');
  });

  it('setQuestProtections(pin, true) sends automation_disable after SET_PROPERTY', async () => {
    await setQuestProtections('1234', true);
    expect(execCommandFull).toHaveBeenCalledTimes(2);
    expect(sentAutomationDisable(execCommandFull.mock.calls.slice(1))).toBe(true);
  });

  it('setQuestProtections(pin, false) does not', async () => {
    await setQuestProtections('1234', false);
    expect(sentAutomationDisable(execCommandFull.mock.calls)).toBe(false);
  });

  it('a rejected SET_PROPERTY skips automation_disable', async () => {
    execCommandFull.mockResolvedValueOnce({ ...ok, stdout: 'Bundle[{Message=PIN verification failed, Success=false}]' });
    await expect(setQuestProtections('1234', true)).rejects.toThrow(/PIN verification failed/);
    expect(sentAutomationDisable(execCommandFull.mock.calls)).toBe(false);
  });

  it('restoreProtectionsSync sends automation_disable too', () => {
    expect(restoreProtectionsSync('1234')).toBeNull();
    expect(sentAutomationDisable(execFileSync.mock.calls)).toBe(true);
  });
});
