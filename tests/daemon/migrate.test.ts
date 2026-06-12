import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupLegacyArtifacts } from '../../src/daemon/migrate.js';

let home: string; let saved: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'qd-home-')); saved = process.env.HOME; process.env.HOME = home; });
afterEach(() => { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; rmSync(home, { recursive: true, force: true }); });

describe('cleanupLegacyArtifacts', () => {
  it('removes a legacy daemon.json and stay-awake pid when their pids are dead', () => {
    mkdirSync(join(home, '.local', 'share', 'quest-dev'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'quest-dev', 'daemon.json'), JSON.stringify({ pid: 999999 }));
    writeFileSync(join(home, '.quest-dev-stay-awake.pid'), '999999');
    cleanupLegacyArtifacts((pid) => pid === process.pid); // only our own pid is "alive"
    expect(existsSync(join(home, '.local', 'share', 'quest-dev', 'daemon.json'))).toBe(false);
    expect(existsSync(join(home, '.quest-dev-stay-awake.pid'))).toBe(false);
  });

  it('leaves a legacy artifact whose pid is still alive', () => {
    writeFileSync(join(home, '.quest-dev-stay-awake.pid'), String(process.pid));
    cleanupLegacyArtifacts((pid) => pid === process.pid);
    expect(existsSync(join(home, '.quest-dev-stay-awake.pid'))).toBe(true);
  });
});
