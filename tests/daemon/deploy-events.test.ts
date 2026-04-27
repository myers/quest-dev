import { describe, it, expect } from 'vitest';
import { parseIncrementalProgress, type ProgressUpdate } from '../../src/daemon/deploy.js';

describe('parseIncrementalProgress', () => {
  it('emits one update per ~10% of total, plus a final transferred update', () => {
    const updates: ProgressUpdate[] = [];
    const parser = parseIncrementalProgress((u) => updates.push(u));

    // 100 blocks total — should emit at 10, 20, 30, … 100, then a final "transferred"
    for (let n = 1; n <= 100; n++) {
      parser.feed(`in priority: ${n} of 100\n`);
    }
    parser.end();

    const progress = updates.filter((u) => u.kind === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(9); // at least 9 ticks at 10%
    expect(progress.length).toBeLessThanOrEqual(11);
    expect(progress[0]).toMatchObject({ kind: 'progress', blocks: expect.any(Number), totalBlocks: 100 });

    const transferred = updates.find((u) => u.kind === 'transferred');
    expect(transferred).toBeDefined();
    expect(transferred).toMatchObject({ kind: 'transferred', blocksTransferred: 100, totalBlocks: 100 });
  });

  it('emits no updates when there is no incremental output', () => {
    const updates: ProgressUpdate[] = [];
    const parser = parseIncrementalProgress((u) => updates.push(u));
    parser.feed('Performing Streamed Install\nSuccess\n');
    parser.end();
    expect(updates).toEqual([]);
  });

  it('handles a chunk that splits a match across feed boundaries', () => {
    const updates: ProgressUpdate[] = [];
    const parser = parseIncrementalProgress((u) => updates.push(u));
    parser.feed('in priority: 50 of ');
    parser.feed('100\n');
    parser.end();
    // At 50% we cross the 10% threshold
    const progress = updates.filter((u) => u.kind === 'progress');
    expect(progress.length).toBe(1);
    expect(progress[0]).toMatchObject({ blocks: 50, totalBlocks: 100, pct: 50 });
  });
});
