import { describe, it, expect } from 'vitest';
import { parseTestProperties, buildSetPropertyArgs } from '../src/commands/stay-awake.js';

describe('parseTestProperties', () => {
  it('parses a full Bundle output', () => {
    const output = 'Bundle[{disable_guardian=true, set_proximity_close=true, disable_dialogs=true, disable_autosleep=true}]';
    const props = parseTestProperties(output);
    expect(props).toEqual({
      disable_guardian: true,
      set_proximity_close: true,
      disable_dialogs: true,
      disable_autosleep: true,
    });
  });

  it('parses Bundle with false values', () => {
    const output = 'Bundle[{disable_guardian=false, set_proximity_close=false, disable_dialogs=false, disable_autosleep=false}]';
    const props = parseTestProperties(output);
    expect(props).toEqual({
      disable_guardian: false,
      set_proximity_close: false,
      disable_dialogs: false,
      disable_autosleep: false,
    });
  });

  it('returns defaults for unparseable output', () => {
    const props = parseTestProperties('some garbage output');
    expect(props).toEqual({
      disable_guardian: false,
      set_proximity_close: false,
      disable_dialogs: false,
      disable_autosleep: false,
    });
  });

  it('returns defaults for empty string', () => {
    const props = parseTestProperties('');
    expect(props).toEqual({
      disable_guardian: false,
      set_proximity_close: false,
      disable_dialogs: false,
      disable_autosleep: false,
    });
  });
});

describe('buildSetPropertyArgs', () => {
  it('builds enable args with correct PIN', () => {
    const args = buildSetPropertyArgs('5678', true);
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

  it('builds disable args', () => {
    const args = buildSetPropertyArgs('1234', false);
    expect(args).toContain('disable_guardian:b:false');
    expect(args).toContain('disable_dialogs:b:false');
    expect(args).toContain('disable_autosleep:b:false');
    expect(args).toContain('set_proximity_close:b:false');
    expect(args).toContain('PIN:s:1234');
  });
});
