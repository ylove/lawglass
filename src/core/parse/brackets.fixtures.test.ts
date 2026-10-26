/** Real files stay local. Expected runs were counted on the rendered official PDFs. */
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import { readManifest } from '../../../scripts/fixture-manifest.js';
import { parsePdf } from './pdf.js';
import { parseHtml } from './html.js';
import {
  sectionText,
  walkSections,
  type NormalizedDoc,
  type Span,
} from '../model/index.js';
import { chunkDocument } from '../chunk/index.js';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const spans = (doc: NormalizedDoc) =>
  [...walkSections(doc.sections)].flatMap((s) => s.spans);
/** Join a continued visual deletion across printed lines and section boundaries. */
function deletionRuns(doc: NormalizedDoc): string[] {
  const runs: string[] = [];
  let current = '';
  for (const span of spans(doc)) {
    if (span.status === 'deleted') current += span.text;
    else if (span.text.trim() && current) {
      runs.push(normalize(current));
      current = '';
    }
  }
  if (current) runs.push(normalize(current));
  return runs;
}
function load(name: string): () => NormalizedDoc {
  let doc: NormalizedDoc;
  beforeAll(async () => {
    const fixture = readManifest().fixtures.find((f) => f.name === name)!;
    const bytes = readFileSync(fixturePath(name)!);
    const context = {
      sourceUrl: fixture.url,
      fetchedAt: '2026-10-25T00:00:00.000Z',
    };
    doc =
      fixture.format === 'html'
        ? parseHtml(bytes, context)
        : await parsePdf(bytes, context);
  });
  return () => doc;
}
const nyDeleted = ['[fifteen]', '[non-voting]', '[and]', '[non-voting]'];
for (const name of ['ny-s1234-2025-introduced', 'ny-s1234-2025-assembly']) {
  describeWithFixture(name, () => {
    const doc = load(name);
    it('finds all 4 manually counted deletions and no false positives', () => {
      expect(deletionRuns(doc())).toEqual(nyDeleted);
      expect(doc().metadata).toMatchObject({
        billNumber: 'S. 1234',
        jurisdiction: 'New York',
        sponsors: ['MAY'],
        version: 'Introduced',
      });
      const inserted = normalize(
        spans(doc())
          .filter((s) => s.status === 'inserted')
          .map((s) => s.text)
          .join(' '),
      );
      for (const phrase of [
        'ten',
        'one of whom shall be appointed by the speaker of the assembly',
        'elected to serve as trustee by a majority vote of staff members',
      ])
        expect(inserted).toContain(phrase);
    });
    it('keeps the printed enacting clause unchanged without a spurious whole-line rule warning', () => {
      const enacting = spans(doc()).filter((s) =>
        /The\s+People|bly, do enact/.test(s.text),
      );
      expect(enacting.length).toBeGreaterThan(0);
      expect(enacting.every((s) => s.status === 'unchanged')).toBe(true);
      expect(doc().warnings.join(' ')).not.toContain(
        'one rule marks the whole line',
      );
    });
    it('never leaks the repealed trustee count into current text, headings or indexed chunks', () => {
      const current = [...walkSections(doc().sections)]
        .map(
          (s) =>
            `${s.heading ?? ''} ${sectionText(s, { includeDeleted: false })}`,
        )
        .join('');
      expect(current).not.toContain('fifteen');
      expect(current).not.toContain('EXPLANATION');
      for (const chunk of chunkDocument(doc()).filter(
        (c) => c.amendmentStatus !== 'deleted',
      ))
        expect(chunk.text).not.toContain('fifteen');
      expect(doc().sections.map((s) => s.id)).toContain('sec-2');
    });
  });
}
describeWithFixture('ny-s8102-2025-introduced', () => {
  const doc = load('ny-s8102-2025-introduced');
  it('new-law article has zero deletions and its new definitions are inserted', () => {
    expect(deletionRuns(doc())).toEqual([]);
    expect(doc().metadata).toMatchObject({
      billNumber: 'S. 8102',
      sponsors: ['GOUNARDES'],
      version: 'Introduced',
    });
    const definition = [...walkSections(doc().sections)].find(
      (s) => s.id === 'sec-1509/1',
    );
    expect(definition).toBeDefined();
    expect(
      definition!.spans
        .filter((s) => s.text.trim())
        .every((s) => s.status === 'inserted'),
    ).toBe(true);
  });
});
describeWithFixture('nj-s1446-2024-r2', () => {
  const doc = load('nj-s1446-2024-r2');
  it('finds all 12 manually counted runs, including superscript committee brackets, without cover/header/legend false positives', () => {
    expect(deletionRuns(doc())).toEqual([
      '[,]',
      '[, and each member of whose household]',
      '[3-year]',
      '[rules and regulations]',
      '[has not owned any residential real property as their principal residence within the preceding three years, and]',
      '[the]',
      '[of $15,000]',
      '[not less than eight hours of]',
      '[shall]',
      '[promulgate rules and regulations pursuant to the "Administrative Procedure Act," P.L.1968, c.410 (C.52:14B-1 et seq.) to effectuate, administer, and accomplish the purposes of the loan program. Notwithstanding the limitations established in section 1 of P.L.2011, c.215 (C.52:14B-3a) on the use of regulatory guidance documents, the executive director shall prepare and disseminate guidelines or regulatory guidance documents, on or before the first day of the third month next following the enactment of P.L.2023, c.78 (C.55:14K-104 et al.), in advance of the adoption of rules and regulations]',
      '[, guidance documents, and rules and regulations]',
      '[3.]',
    ]);
    const body = spans(doc())
      .filter((s: Span) => s.page === 2 && s.line === 27)
      .map((s) => s.text)
      .join('');
    expect(body).not.toMatch(/1\[|\]1/);
    const inserted = normalize(
      spans(doc())
        .filter((s) => s.status === 'inserted')
        .map((s) => s.text)
        .join(' '),
    );
    for (const phrase of [
      'three-year',
      'guidelines',
      'not to exceed $20,000',
      'develop program guidelines',
    ])
      expect(inserted).toContain(phrase);
    expect(inserted).not.toContain('BE IT ENACTED');
  });
});
