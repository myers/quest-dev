/**
 * Tests for filename generation utilities
 */

import { describe, it, expect } from 'vitest';
import { generateScreenshotFilename } from './filename.js';

describe('generateScreenshotFilename', () => {
  it('formats UTC timestamp correctly', () => {
    const date = new Date('2026-01-15T14:30:45Z');
    expect(generateScreenshotFilename(date))
      .toBe('screenshot-2026-01-15-14-30-45-Z.jpg');
  });

  it('pads single digits with zeros', () => {
    const date = new Date('2026-01-05T08:09:03Z');
    expect(generateScreenshotFilename(date))
      .toBe('screenshot-2026-01-05-08-09-03-Z.jpg');
  });

  it('handles midnight correctly', () => {
    const date = new Date('2026-12-31T00:00:00Z');
    expect(generateScreenshotFilename(date))
      .toBe('screenshot-2026-12-31-00-00-00-Z.jpg');
  });

  it('generates filename with current time when no date provided', () => {
    const filename = generateScreenshotFilename();

    // Verify format is correct
    expect(filename).toMatch(/^screenshot-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-Z\.jpg$/);

    // Extract timestamp from filename
    const match = filename.match(/^screenshot-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-Z\.jpg$/);
    expect(match).not.toBeNull();

    if (match) {
      const [, year, month, day, hours, minutes, seconds] = match;
      const filenameDate = new Date(Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hours),
        parseInt(minutes),
        parseInt(seconds)
      ));

      // Verify the timestamp is reasonable (within last minute)
      const now = new Date();
      const diff = now.getTime() - filenameDate.getTime();
      expect(diff).toBeGreaterThanOrEqual(0);
      expect(diff).toBeLessThan(60000); // Within last 60 seconds
    }
  });
});
