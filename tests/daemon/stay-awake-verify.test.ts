import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression for the "Stay-awake: enabled over a headset with the properties
// still on" bug: turnOn() must read GET_PROPERTY back rather than trust
// SET_PROPERTY's return value or its own in-memory flag.
const setQuestProtections = vi.fn();
const getQuestProtections = vi.fn();

vi.mock('../../src/utils/quest-protections.js', () => ({
  setQuestProtections,
  getQuestProtections,
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
