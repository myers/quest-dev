import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeRegistry, readRegistry, type DaemonRecord } from '../../src/daemon/registry.js';

let dir: string; let saved: string | undefined;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qd-regi-')); saved = process.env.XDG_RUNTIME_DIR; process.env.XDG_RUNTIME_DIR = dir; });
afterEach(() => { if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved; rmSync(dir, { recursive: true, force: true }); });

describe('two serials coexist', () => {
  it('keeps independent records for two devices', () => {
    const a: DaemonRecord = { pid: 1, port: 40001, serial: 'SERIAL_A', address: '127.0.0.1:5555', cdpPort: 9230, castPort: 41001, startedAt: 't' };
    const b: DaemonRecord = { pid: 2, port: 40002, serial: 'SERIAL_B', address: 'quest3.home.arap:5555', cdpPort: 9240, castPort: 41002, startedAt: 't' };
    writeRegistry(a); writeRegistry(b);
    expect(readRegistry('SERIAL_A')).toEqual(a);
    expect(readRegistry('SERIAL_B')).toEqual(b);
  });
});
