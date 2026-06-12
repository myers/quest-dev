import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registryPath, writeRegistry, readRegistry, removeRegistry, type DaemonRecord } from '../../src/daemon/registry.js';

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qd-reg-'));
  saved = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const rec: DaemonRecord = {
  pid: process.pid, port: 40000, serial: '192.168.1.50:5555',
  address: '192.168.1.50:5555', cdpPort: 9230, castPort: 41000, startedAt: '2026-06-12T00:00:00Z',
};

describe('daemon registry', () => {
  it('derives a sanitized per-serial path under runtimeDir/daemons', () => {
    const p = registryPath('192.168.1.50:5555');
    expect(p).toContain(join('quest-dev', 'daemons'));
    expect(p.endsWith('192_168_1_50_5555.json')).toBe(true);
  });

  it('writes and reads back a record', () => {
    writeRegistry(rec);
    expect(readRegistry('192.168.1.50:5555')).toEqual(rec);
  });

  it('returns null for a missing record', () => {
    expect(readRegistry('NOSUCH')).toBeNull();
  });

  it('removes a record', () => {
    writeRegistry(rec);
    removeRegistry('192.168.1.50:5555');
    expect(existsSync(registryPath('192.168.1.50:5555'))).toBe(false);
    expect(readRegistry('192.168.1.50:5555')).toBeNull();
  });
});
