import { describe, it, expect } from 'vitest';
import {
  parseQuestProtections,
  buildSetPropertyArgs,
  trackUnpluggedDuration,
  shouldExitOnUnplug,
} from '../src/commands/stay-awake.js';
import { parseSetPropertyError } from '../src/utils/quest-protections.js';

describe('parseQuestProtections', () => {
  it('parses a Bundle where every protection is off (stay-awake on)', () => {
    // Wire format uses negative-form names; all `disable_*=true` means everything is off.
    const output = 'Bundle[{disable_guardian=true, set_proximity_close=true, disable_dialogs=true, disable_autosleep=true}]';
    const props = parseQuestProtections(output);
    expect(props).toEqual({
      guardian: false,
      proximityClose: false,
      dialogs: false,
      autosleep: false,
    });
  });

  it('parses a Bundle where every protection is on (normal Quest state)', () => {
    const output = 'Bundle[{disable_guardian=false, set_proximity_close=false, disable_dialogs=false, disable_autosleep=false}]';
    const props = parseQuestProtections(output);
    expect(props).toEqual({
      guardian: true,
      proximityClose: true,
      dialogs: true,
      autosleep: true,
    });
  });

  it('returns all-on defaults for unparseable output', () => {
    const props = parseQuestProtections('some garbage output');
    expect(props).toEqual({
      guardian: true,
      proximityClose: true,
      dialogs: true,
      autosleep: true,
    });
  });

  it('returns all-on defaults for empty string', () => {
    const props = parseQuestProtections('');
    expect(props).toEqual({
      guardian: true,
      proximityClose: true,
      dialogs: true,
      autosleep: true,
    });
  });
});

describe('buildSetPropertyArgs', () => {
  it('builds args to turn protections off (stay-awake on)', () => {
    const args = buildSetPropertyArgs('5678', false);
    expect(args).toEqual([
      'shell', 'content', 'call',
      '--uri', 'content://com.oculus.rc',
      '--method', 'SET_PROPERTY',
      '--extra', 'disable_guardian:b:true',
      '--extra', 'disable_dialogs:b:true',
      '--extra', 'disable_autosleep:b:true',
      '--extra', 'set_proximity_close:b:true',
      '--extra', 'PIN:s:5678',
    ]);
  });

  it('builds args to turn protections on (stay-awake off)', () => {
    const args = buildSetPropertyArgs('1234', true);
    expect(args).toContain('disable_guardian:b:false');
    expect(args).toContain('disable_dialogs:b:false');
    expect(args).toContain('disable_autosleep:b:false');
    expect(args).toContain('set_proximity_close:b:false');
    expect(args).toContain('PIN:s:1234');
  });
});

describe('trackUnpluggedDuration', () => {
  it('accumulates elapsed time while not charging', () => {
    expect(trackUnpluggedDuration(0, 'not charging', 60000)).toBe(60000);
    expect(trackUnpluggedDuration(60000, 'not charging', 60000)).toBe(120000);
  });

  it('resets to zero when charging', () => {
    expect(trackUnpluggedDuration(120000, 'charging', 60000)).toBe(0);
  });

  it('resets to zero when fast charging', () => {
    expect(trackUnpluggedDuration(120000, 'fast charging', 60000)).toBe(0);
  });

  it('forgives a brief unplug that returns to charging (counter clears)', () => {
    // unplug for one poll...
    let acc = trackUnpluggedDuration(0, 'not charging', 60000);
    expect(acc).toBe(60000);
    // ...then plugged back in before the grace window elapses
    acc = trackUnpluggedDuration(acc, 'charging', 60000);
    expect(acc).toBe(0);
  });
});

describe('shouldExitOnUnplug', () => {
  it('does not exit while the accumulated unplugged time is below the threshold', () => {
    expect(shouldExitOnUnplug(60000, 300000)).toBe(false);
    expect(shouldExitOnUnplug(240000, 300000)).toBe(false);
  });

  it('exits once accumulated unplugged time reaches the threshold', () => {
    expect(shouldExitOnUnplug(300000, 300000)).toBe(true);
    expect(shouldExitOnUnplug(360000, 300000)).toBe(true);
  });

  it('never exits when the threshold is 0 (feature disabled)', () => {
    expect(shouldExitOnUnplug(0, 0)).toBe(false);
    expect(shouldExitOnUnplug(600000, 0)).toBe(false);
    expect(shouldExitOnUnplug(86400000, 0)).toBe(false);
  });

  it('treats negative thresholds as disabled', () => {
    expect(shouldExitOnUnplug(600000, -1)).toBe(false);
  });
});

describe('parseSetPropertyError', () => {
  // `adb shell content call` exits 0 whatever the provider decides; this bundle
  // is the only place a rejected SET_PROPERTY shows up. Captured verbatim from
  // Quest 3 2G0YC1ZF7V0HP1 on 2026-09-08, where `stay-awake --off` reported
  // success while every protection stayed off.
  it('extracts the message from a rejected call', () => {
    const output =
      'Result: Bundle[{Message=PIN verification failed: com.oculus.auth.components.HttpError: ' +
      'com.oculus.http.core.base.ApiError: retrofit.RetrofitError: 400 - NON_NETWORK_ISSUE, Success=false}]';
    expect(parseSetPropertyError(output)).toMatch(/^PIN verification failed/);
  });

  it('returns null for an accepted call', () => {
    expect(parseSetPropertyError('Result: Bundle[{Success=true}]')).toBeNull();
  });

  it('returns null for output it does not recognise', () => {
    // Better to miss a failure than invent one: callers verify with GET_PROPERTY.
    expect(parseSetPropertyError('')).toBeNull();
    expect(parseSetPropertyError('Result: Bundle[{}]')).toBeNull();
  });

  it('still reports a failure with no Message field', () => {
    expect(parseSetPropertyError('Result: Bundle[{Success=false}]')).toBe(
      'SET_PROPERTY returned Success=false',
    );
  });
});
