import { describe, it, expect } from 'vitest';
import { stayAwakePidPath } from '../src/commands/stay-awake.js';

describe('stayAwakePidPath', () => {
  it('derives a per-serial PID file under runtimeDir', () => {
    const p = stayAwakePidPath('192.168.1.50:5555');
    expect(p.endsWith('stay-awake-192_168_1_50_5555.pid')).toBe(true);
    expect(p).toContain('quest-dev');
  });
});
