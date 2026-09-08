import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression for the "Stay-awake: enabled over a headset with the properties
// still on" bug: turnOn() must read GET_PROPERTY back rather than trust
// SET_PROPERTY's return value or its own in-memory flag.
const setQuestProtections = vi.fn();
const getQuestProtections = vi.fn();

const restoreProtectionsSync = vi.fn();

vi.mock('../../src/utils/quest-protections.js', () => ({
  setQuestProtections,
  getQuestProtections,
  restoreProtectionsSync,
  buildSetPropertyArgs: () => [],
  formatQuestProtections: () => '',
}));
vi.mock('../../src/utils/exec.js', () => ({ execCommand: vi.fn() }));

const { StayAwakeManager } = await import('../../src/daemon/stay-awake-manager.js');

const allOff = { guardian: false, dialogs: false, autosleep: false, proximityClose: false };

describe('StayAwakeManager.turnOn', () => {
  beforeEach(() => {
    setQuestProtections.mockReset().mockResolvedValue(undefined);
    getQuestProtections.mockReset();
  });

  it('throws when GET_PROPERTY still reports protections on', async () => {
    getQuestProtections.mockResolvedValue({ ...allOff, guardian: true, dialogs: true });
    const m = new StayAwakeManager();
    await expect(m.turnOn('1234')).rejects.toThrow(/guardian, dialogs/);
    expect(m.isEnabled).toBe(false);
  });

  it('succeeds and marks itself enabled when GET_PROPERTY confirms', async () => {
    getQuestProtections.mockResolvedValue(allOff);
    const m = new StayAwakeManager();
    await m.turnOn('1234');
    expect(m.isEnabled).toBe(true);
  });

  it('re-applies and re-verifies when already marked enabled', async () => {
    getQuestProtections.mockResolvedValue(allOff);
    const m = new StayAwakeManager();
    await m.turnOn('1234');
    await m.turnOn('1234');
    expect(setQuestProtections).toHaveBeenCalledTimes(2);
    expect(getQuestProtections).toHaveBeenCalledTimes(2);
  });
});

const allOn = { guardian: true, dialogs: true, autosleep: true, proximityClose: true };

// Regression for "stay-awake --off reports success without restoring
// protections": turnOff() must read GET_PROPERTY back, must not early-return on
// its own stale flag, and must throw so /stay-awake/disable can report it.
describe('StayAwakeManager.turnOff', () => {
  beforeEach(() => {
    setQuestProtections.mockReset().mockResolvedValue(undefined);
    getQuestProtections.mockReset();
    restoreProtectionsSync.mockReset().mockReturnValue(null);
  });

  it('throws when GET_PROPERTY still reports protections off', async () => {
    getQuestProtections.mockResolvedValue(allOff);
    const m = new StayAwakeManager();
    await m.turnOn('1234');
    getQuestProtections.mockResolvedValue({ ...allOn, autosleep: false, guardian: false });
    await expect(m.turnOff()).rejects.toThrow(/guardian, autosleep/);
  });

  it('succeeds and clears its flag when GET_PROPERTY confirms', async () => {
    getQuestProtections.mockResolvedValue(allOff);
    const m = new StayAwakeManager();
    await m.turnOn('1234');
    getQuestProtections.mockResolvedValue(allOn);
    await m.turnOff();
    expect(m.isEnabled).toBe(false);
  });

  it('still talks to the device when its flag says already off', async () => {
    getQuestProtections.mockResolvedValue(allOn);
    const m = new StayAwakeManager();
    await m.turnOff('1234');
    expect(setQuestProtections).toHaveBeenCalledWith('1234', true);
  });

  it('throws rather than no-oping when no PIN is known', async () => {
    const m = new StayAwakeManager();
    await expect(m.turnOff()).rejects.toThrow(/No PIN known/);
    expect(setQuestProtections).not.toHaveBeenCalled();
  });

  it('names the provider rejection when the restore did not take', async () => {
    // The 2026-09-08 device case: SET_PROPERTY answers Success=false and every
    // protection stays off. The error has to carry the provider's own reason.
    setQuestProtections.mockRejectedValue(new Error('SET_PROPERTY rejected: PIN verification failed'));
    getQuestProtections.mockResolvedValue(allOff);
    const m = new StayAwakeManager();
    await expect(m.turnOff('1234')).rejects.toThrow(/PIN verification failed/);
  });

  it('succeeds despite a provider rejection when the readback says protections are on', async () => {
    setQuestProtections.mockRejectedValue(new Error('SET_PROPERTY rejected: PIN verification failed'));
    getQuestProtections.mockResolvedValue(allOn);
    const m = new StayAwakeManager();
    await m.turnOff('1234');
    expect(m.isEnabled).toBe(false);
  });
});

describe('StayAwakeManager.cleanupSync', () => {
  beforeEach(() => {
    setQuestProtections.mockReset().mockResolvedValue(undefined);
    getQuestProtections.mockReset().mockResolvedValue(allOff);
    restoreProtectionsSync.mockReset().mockReturnValue(null);
  });

  it('reports a rejected restore instead of exiting quietly', async () => {
    restoreProtectionsSync.mockReturnValue('PIN verification failed');
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m) => { errors.push(String(m)); });
    const m = new StayAwakeManager();
    await m.turnOn('1234');
    m.cleanupSync();
    spy.mockRestore();
    expect(errors.join(' ')).toMatch(/PIN verification failed/);
    expect(m.isEnabled).toBe(true);
  });
});
