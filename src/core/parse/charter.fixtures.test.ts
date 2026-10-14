/**
 * Local-only check against the Columbus Issue 8 charter amendment (gitignored download; the
 * file is not in the fixture manifest yet, so presence is checked directly and the suite
 * skips when absent). Sec. 46-3 is deliberately not asserted: it is dropped by a separate
 * skew bug (#192).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkSections } from '../model/index.js';
import { parsePdf } from './index.js';

const path = join(
  process.cwd(),
  'fixtures',
  'downloads',
  'oh-columbus-issue8-2026.pdf',
);

describe.skipIf(!existsSync(path))('oh-columbus-issue8-2026', () => {
  it('parses charter section headings without a leading dash', async () => {
    const doc = await parsePdf(readFileSync(path), {
      sourceUrl: 'https://vote.franklincountyohio.gov/issue8.pdf',
      fetchedAt: '2026-10-14T00:00:00.000Z',
    });
    const sections = [...walkSections(doc.sections)].filter((s) =>
      s.id.startsWith('sec-'),
    );
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections)
      expect(section.heading ?? '').not.toMatch(/^[-–—]/);
  });
});
