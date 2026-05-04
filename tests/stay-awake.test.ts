import { describe, it, expect } from 'vitest';
import { parseTestProperties, buildSetPropertyArgs } from '../src/commands/stay-awake.js';

describe('parseTestProperties', () => {
  it('parses a Bundle where every protection is off (stay-awake on)', () => {
    // Wire format uses negative-form names; all `disable_*=true` means everything is off.
    const output = 'Bundle[{disable_guardian=true, set_proximity_close=true, disable_dialogs=true, disable_autosleep=true}]';
    const props = parseTestProperties(output);
    expect(props).toEqual({
      guardian: false,
      proximityClose: false,
      dialogs: false,
      autosleep: false,
    });
  });

  it('parses a Bundle where every protection is on (normal Quest state)', () => {
    const output = 'Bundle[{disable_guardian=false, set_proximity_close=false, disable_dialogs=false, disable_autosleep=false}]';
    const props = parseTestProperties(output);
    expect(props).toEqual({
      guardian: true,
      proximityClose: true,
      dialogs: true,
      autosleep: true,
    });
  });

  it('returns all-on defaults for unparseable output', () => {
    const props = parseTestProperties('some garbage output');
    expect(props).toEqual({
      guardian: true,
      proximityClose: true,
      dialogs: true,
      autosleep: true,
    });
  });

  it('returns all-on defaults for empty string', () => {
    const props = parseTestProperties('');
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
