import { describe, expect, it } from 'vitest';
import { trimEdgesWhile, trimEndWhile, trimStartWhile } from './trim.js';

const dash = (c: string): boolean => c === '-';

describe('linear trimming', () => {
  it('trims one edge or both', () => {
    expect(trimEndWhile('a--', dash)).toBe('a');
    expect(trimStartWhile('--a', dash)).toBe('a');
    expect(trimEdgesWhile('--a-b--', dash)).toBe('a-b');
  });

  it('handles empty, untouched and fully trimmed input', () => {
    expect(trimEndWhile('', dash)).toBe('');
    expect(trimEndWhile('abc', dash)).toBe('abc');
    expect(trimStartWhile('----', dash)).toBe('');
    expect(trimEdgesWhile('----', dash)).toBe('');
  });

  it('stays fast on a long run that is not at the end', () => {
    const hostile = `${'-'.repeat(200_000)}x`;
    const started = performance.now();
    expect(trimEndWhile(hostile, dash)).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
