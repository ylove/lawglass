/**
 * Local-only check against the Columbus Issue 8 charter amendment (gitignored download; the
 * file is not in the fixture manifest yet, so presence is checked directly and the suite
 * skips when absent). Sec. 46-3 is deliberately not asserted: it is dropped by a separate
 * skew bug (#192).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_METADATA, sectionText, walkSections } from '../model/index.js';
import { extractMetadata } from '../enrich/metadata.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
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

describe.skipIf(!existsSync(path))(
  'oh-columbus-issue8-2026 metadata guard',
  () => {
    it('keeps "City of Columbus, Ohio" via the host state, rejects Georgia', async () => {
      const sourceUrl =
        'https://vote.franklincountyohio.gov/getmedia/issue8.pdf';
      const doc = await parsePdf(readFileSync(path), {
        sourceUrl,
        fetchedAt: '2026-10-14T00:00:00.000Z',
      });
      const text = [...walkSections(doc.sections)]
        .map((s) => sectionText(s, { includeDeleted: false }))
        .join('\n');
      const run = async (jurisdiction: string) =>
        (
          await extractMetadata(
            { metadata: EMPTY_METADATA, sourceUrl },
            {
              provider: new ScriptedProvider({
                objects: {
                  bill_metadata: {
                    title: null,
                    billNumber: null,
                    jurisdiction,
                    session: null,
                    version: null,
                    sponsors: null,
                  },
                },
              }),
              text,
            },
          )
        ).metadata.jurisdiction;
      expect(await run('City of Columbus, Ohio')).toBe(
        'City of Columbus, Ohio',
      );
      expect(await run('City of Columbus, Georgia')).toBeNull();
    });
  },
);
