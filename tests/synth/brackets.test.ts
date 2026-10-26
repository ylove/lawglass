import { expect, it } from 'vitest';
import { bracketHtml, bracketPdf, bracketText, NJ_LEGEND } from './brackets.js';

it('generates text and HTML from the same invented bill under either legend', () => {
  expect(bracketText()).toContain('S. 4321--A');
  expect(bracketHtml(NJ_LEGEND)).toContain(NJ_LEGEND);
});
it('generates deterministic PDF bytes for each convention', async () => {
  for (const convention of [true, false, 'NJ'] as const) {
    const first = await bracketPdf(convention);
    expect(first).toEqual(await bracketPdf(convention));
    expect(Buffer.from(first).subarray(0, 5).toString()).toBe('%PDF-');
  }
});
