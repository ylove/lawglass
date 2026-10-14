import { describe, expect, test } from 'vitest';
import { formatRecordDate } from './format-date.js';

describe('formatRecordDate', () => {
  test('formats dates and timestamps', () => {
    expect(formatRecordDate('2025-01-23')).toBe('Jan 23, 2025');
    expect(formatRecordDate('2025-01-23T05:00:00Z')).toBe('Jan 23, 2025');
  });
  test('does not shift the day near midnight UTC', () => {
    expect(formatRecordDate('2025-01-23T00:00:00Z')).toBe('Jan 23, 2025');
    expect(formatRecordDate('2025-01-23T23:59:59Z')).toBe('Jan 23, 2025');
  });
  test('returns unparseable input unchanged', () => {
    expect(formatRecordDate('sometime in 2025')).toBe('sometime in 2025');
    expect(formatRecordDate('')).toBe('');
  });
});
