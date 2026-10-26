/**
 * Local-only check against the Columbus Issue 8 charter amendment (gitignored download; the
 * file is not in the fixture manifest yet, so presence is checked directly and the suite
 * skips when absent). The scan is Adobe ClearScan with 0.5 to 0.7 degrees of skew (#192).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_METADATA, sectionText, walkSections } from '../model/index.js';
import { extractMetadata } from '../enrich/metadata.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { parsePdf } from './index.js';
import { SCAN_WARNING } from './pdf.js';

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
  'oh-columbus-issue8-2026 scan (#192)',
  () => {
    const parse = () =>
      parsePdf(readFileSync(path), {
        sourceUrl: 'https://vote.franklincountyohio.gov/issue8.pdf',
        fetchedAt: '2026-10-14T00:00:00.000Z',
      });

    it('keeps Sec. 46-3, which sits on the skewed page, with its text', async () => {
      const doc = await parse();
      const ids = [...walkSections(doc.sections)].map((s) => s.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          'sec-3',
          'sec-4',
          'sec-41-5',
          'sec-46',
          'sec-46-3',
        ]),
      );
      const section = [...walkSections(doc.sections)].find(
        (s) => s.id === 'sec-46-3',
      )!;
      const body = sectionText(section, { includeDeleted: true }).replace(
        /\s+/g,
        ' ',
      );
      expect(section.heading ?? body).toMatch(/Placement of recall/);
      expect(body).toContain(
        'The question of the removal of the elective officer shall be submitted',
      );
      expect(body).toContain(
        'days after the city clerk determines the sufficiency',
      );
      expect(doc.warnings.join('\n')).not.toMatch(/rotated/);
    });

    it('puts a space where OCR items are separated by a space item', async () => {
      const doc = await parse();
      const all = [...walkSections(doc.sections)]
        .map((s) => sectionText(s, { includeDeleted: true }))
        .join('\n');
      expect(all).not.toMatch(/\bofthe\b/);
      expect(all).toContain('electors of the');
    });

    it('is flagged as a scan, with the page marked not-read', async () => {
      const doc = await parse();
      expect(doc.warnings).toContain(SCAN_WARNING);
      expect(doc.scan).toEqual({ pages: [{ page: 2, marks: 'not-read' }] });
    });
  },
);

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
