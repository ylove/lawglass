/**
 * Local-only checks against real Ohio bills (fixtures/downloads, never committed; they skip
 * when absent: `npm run fixtures:fetch`). Every expected string was read off the rendered page.
 *
 * SB 113 and SB 203 strike no text: both only add language. They still test the hard parts on
 * real geometry: underlines 1.4pt and 2.7pt below the baseline, line numbers in the right
 * margin that continue across pages, two-line running headers, and decorative bars on page
 * 1 that must not read as strikethrough. HB 62 strikes and inserts, so it tests the spec's
 * core promise on real output: struck text never reaches a heading, breadcrumb or embedding.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import {
  sectionText,
  walkSections,
  type NormalizedDoc,
  type Section,
  type Span,
} from '../model/index.js';
import { chunkDocument } from '../chunk/index.js';
import { parsePdf } from './index.js';

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

function checkSubdivisionChunks(doc: () => NormalizedDoc): void {
  it('never repeats a subdivision lead-in ahead of its source text', () => {
    const sections = new Map(
      [...walkSections(doc().sections)].map((s) => [s.id, s]),
    );
    const chunks = chunkDocument(doc());
    expect(chunks.some((c) => c.coveredSectionIds)).toBe(true);
    for (const chunk of chunks.filter((c) => c.amendmentStatus !== 'deleted')) {
      expect(chunk.text).not.toMatch(/\n{3,}/);
      const covered = (chunk.coveredSectionIds ?? [chunk.sectionId]).map((id) =>
        sections.get(id)!,
      );
      const source = normalize(
        covered.map((s) => sectionText(s, { includeDeleted: false })).join(' '),
      );
      for (const section of covered.filter((s) => s.num?.startsWith('('))) {
        const lead = normalize(sectionText(section, { includeDeleted: false }))
          .split(' ')
          .slice(0, 8)
          .join(' ');
        if (!lead) continue;
        const occurrences = (text: string) => text.split(lead).length - 1;
        expect(
          occurrences(normalize(chunk.text)),
          `${section.id}: ${lead}`,
        ).toBeLessThanOrEqual(occurrences(source));
      }
    }
  });
}

function load(name: string): () => NormalizedDoc {
  let doc: NormalizedDoc | undefined;
  beforeAll(async () => {
    doc = await parsePdf(readFileSync(fixturePath(name)!), {
      sourceUrl: 'https://search-prod.lis.state.oh.us/fixture.pdf',
      fetchedAt: '2026-10-13T00:00:00.000Z',
    });
  });
  return () => doc!;
}

function section(doc: NormalizedDoc, id: string): Section {
  const found = [...walkSections(doc.sections)].find((s) => s.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

const spans = (doc: NormalizedDoc): Span[] =>
  [...walkSections(doc.sections)].flatMap((s) => s.spans);

/** Status runs as [status, text, page, line], whitespace normalized. */
const runs = (s: Section, status: Span['status']) =>
  s.spans
    .filter((span) => span.status === status)
    .map((span) => [normalize(span.text), span.page, span.line]);

function expectDocumentBasics(
  doc: NormalizedDoc,
  pageCount: number,
  lastLine: number,
  topLevel: string[],
): void {
  expect(doc.pageCount).toBe(pageCount);
  expect(doc.warnings).toEqual([]);
  expect(doc.sections.map((s) => s.id)).toEqual(topLevel);
  // No struck text anywhere: the page-1 decorative bars are not strikethrough.
  expect(spans(doc).filter((span) => span.status === 'deleted')).toEqual([]);
  // Line numbers run on across pages and only ever go up in reading order.
  const lines = spans(doc).flatMap((span) => (span.line ? [span.line] : []));
  expect(lines).toEqual([...lines].sort((a, b) => a - b));
  expect(lines.at(-1)).toBe(lastLine);
  // Running headers are gone; the page-1 title status is kept for metadata.
  const text = spans(doc)
    .map((span) => span.text)
    .join('');
  expect(text).not.toMatch(/Page \d+/);
  expect(text.match(/As Introduced/g)).toHaveLength(1);
}

describeWithFixture('oh-sb113-136-in', () => {
  const doc = load('oh-sb113-136-in');
  checkSubdivisionChunks(doc);

  it('parses the bill: pages, numbering, structure, no struck text', () => {
    expectDocumentBasics(doc(), 17, 459, [
      'preamble',
      'sec-1',
      'sec-3313.475',
      'sec-3314.03',
      'sec-3326.11',
      'sec-3328.24',
      'sec-2',
      'sec-3',
    ]);
  });

  it('keeps body clauses out of the top-level code section headings and breadcrumbs', () => {
    const ids = ['sec-3314.03', 'sec-3326.11', 'sec-3328.24'];
    const chunks = chunkDocument(doc());
    for (const id of ids) {
      const s = section(doc(), id);
      expect(s.heading, id).toBeUndefined();
      const chunk = chunks.find((c) => c.sectionId === id)!;
      expect(chunk.breadcrumb).toBe(`Sec. ${s.num!}`);
      expect(chunk.text).toContain(`Sec. ${s.num!}.`);
    }
  });

  it('spot check 1: the enacting clause, Section 1, is unchanged (p. 1, lines 5-7)', () => {
    const s = section(doc(), 'sec-1');
    expect(s).toMatchObject({ pageStart: 1, lineStart: 5, lineEnd: 7 });
    expect(runs(s, 'inserted')).toEqual([]);
    expect(normalize(sectionText(s, { includeDeleted: true }))).toBe(
      'Section 1. That sections 3314.03, 3326.11, and 3328.24 be amended and section 3313.475 of the Revised Code be enacted to read as follows:',
    );
  });

  it('spot check 2: new section 3313.475(A)(1) is wholly underlined (p. 1, lines 13-14)', () => {
    const s = section(doc(), 'sec-3313.475/a/1');
    expect(s).toMatchObject({ pageStart: 1, lineStart: 13, lineEnd: 14 });
    expect(runs(s, 'unchanged')).toEqual([]);
    expect(runs(s, 'inserted')).toEqual([
      ['(1) Any orientation or training course regarding', 1, 13],
      ['diversity, equity, and inclusion;', 1, 14],
    ]);
    // The new section's number is itself underlined.
    expect(runs(section(doc(), 'sec-3313.475'), 'inserted')).toEqual([
      ['Sec. 3313.475.', 1, 8],
    ]);
  });

  it('spot check 3: one cross-reference inserted mid-list in 3314.03(A)(11)(d) (p. 5, line 123)', () => {
    const s = section(doc(), 'sec-3314.03/a/11/d');
    expect(runs(s, 'inserted')).toEqual([['3313.475,', 5, 123]]);
    const line123 = s.spans
      .filter((span) => span.line === 123)
      .map((span) => span.text)
      .join('');
    expect(normalize(line123)).toBe(
      '3313.472, 3313.475, 3313.50, 3313.539, 3313.5310, 3313.5318,',
    );
  });
});

describeWithFixture('oh-sb203-133-in', () => {
  const doc = load('oh-sb203-133-in');
  checkSubdivisionChunks(doc);

  it('parses the bill: pages, numbering, structure, no struck text', () => {
    expectDocumentBasics(doc(), 21, 598, [
      'preamble',
      'sec-1',
      'sec-2923.27',
      'sec-2929.28',
      'sec-5122.311',
      'sec-2',
    ]);
  });

  it('spot check 4: new 2923.27(A)(6)(a) on page 2 is wholly underlined (lines 35-36)', () => {
    const s = section(doc(), 'sec-2923.27/a/6/a');
    expect(runs(s, 'unchanged')).toEqual([]);
    expect(runs(s, 'inserted')).toEqual([
      ['(a) The sheriff with jurisdiction over the place at which', 2, 35],
      ['the gun show is conducted;', 2, 36],
    ]);
  });

  it('spot check 5: 2929.28(A)(4) is inserted and (B) after it is unchanged (p. 16)', () => {
    const added = section(doc(), 'sec-2929.28/a/4');
    expect(added).toMatchObject({
      pageStart: 16,
      lineStart: 424,
      lineEnd: 427,
    });
    expect(runs(added, 'unchanged')).toEqual([]);
    expect(normalize(sectionText(added, { includeDeleted: false }))).toBe(
      '(4) For a misdemeanor violation of section 2923.27 of the Revised Code, the court shall impose upon the offender a mandatory fine in the amount specified in division (H)(1), (2), or (3) of that section.',
    );
    const kept = section(doc(), 'sec-2929.28/b');
    expect(kept).toMatchObject({ lineStart: 428 });
    expect(runs(kept, 'inserted')).toEqual([]);
  });

  it('spot check 6: phrases inserted mid-sentence in 5122.311(B) (p. 21, lines 579-586)', () => {
    const s = section(doc(), 'sec-5122.311/b');
    expect(runs(s, 'inserted')).toEqual([
      ['requested by sheriffs,', 21, 579],
      ['federally licensed firearms dealers, or point of contact', 21, 580],
      ['agencies', 21, 581],
      ['or 2923.27', 21, 581],
      ['Records checks requested by a federally licensed firearms', 21, 582],
      [
        'dealer or point of contact agency pursuant to section 2923.27 of',
        21,
        583,
      ],
      [
        'the Revised Code shall be conducted, and results of the checks',
        21,
        584,
      ],
      ['shall be provided, immediately upon receipt of the request.', 21, 585],
      ['referred to in this division', 21, 586],
    ]);
    const line581 = s.spans.filter((span) => span.line === 581);
    expect(line581.map((span) => [span.status, span.text])).toEqual([
      ['inserted', 'agencies'],
      ['unchanged', ' pursuant to section 311.41 '],
      ['inserted', 'or 2923.27'],
      ['unchanged', ' of the Revised\n'],
    ]);
  });
});

describeWithFixture('oh-hb62-135-in', () => {
  const doc = load('oh-hb62-135-in');
  checkSubdivisionChunks(doc);
  /** Status runs on one printed line, whitespace normalized and blank runs dropped. */
  const line = (page: number, number: number) =>
    spans(doc())
      .filter((span) => span.page === page && span.line === number)
      .map((span) => [span.status, normalize(span.text)])
      .filter(([, text]) => text);

  it('parses the bill: 26 struck and 28 underlined runs, no warnings', () => {
    expect(doc().pageCount).toBe(5);
    expect(doc().warnings).toEqual([]);
    expect(doc().sections.map((s) => s.id)).toEqual([
      'preamble',
      'sec-1',
      'sec-2307.601',
      'sec-2901.05',
      'sec-2901.09',
      'sec-2',
    ]);
    const all = spans(doc());
    expect(all.filter((span) => span.status === 'deleted')).toHaveLength(26);
    expect(all.filter((span) => span.status === 'inserted')).toHaveLength(28);
  });

  it('p. 1, lines 7-8: "has" and "meaning" struck for "and "vehicle" have" and "meanings"', () => {
    expect(line(1, 7)).toEqual([
      ['unchanged', '(1) "Residence"'],
      ['deleted', 'has'],
      ['inserted', 'and "vehicle" have'],
      ['unchanged', 'the same'],
      ['deleted', 'meaning'],
    ]);
    expect(line(1, 8)[0]).toEqual(['inserted', 'meanings']);
    // This is a definition sentence, not a printed heading.
    expect(section(doc(), 'sec-2307.601/a/1').heading).toBeUndefined();
  });

  it('p. 2, lines 20-21: "lawfully", "a right" and "be" struck; "retreat before using force" inserted', () => {
    const line20 = line(2, 20);
    expect(line20).toContainEqual(['deleted', 'lawfully']);
    expect(line20).toContainEqual(['deleted', 'a right']);
    const line21 = line(2, 21);
    const be = line21.findIndex(
      ([status, text]) => status === 'deleted' && text === 'be',
    );
    expect(be).toBeGreaterThan(-1);
    expect(line21[be + 1]?.[0]).toBe('inserted');
    expect(line21[be + 1]?.[1]).toMatch(/^retreat before using force/);
  });

  it('p. 2, lines 23-27: the whole struck division (C) is deleted and opens no section', () => {
    const struck = [23, 24, 25, 26, 27].flatMap((number) => line(2, number));
    expect(struck.every(([status]) => status === 'deleted')).toBe(true);
    const text = struck.map(([, t]) => t).join(' ');
    expect(text).toMatch(
      /^\(C\) A trier of fact shall not consider the possibility of retreat/,
    );
    expect(text).toMatch(
      /necessary to prevent injury, loss, or risk to life or safety\.$/,
    );
    const ids = [...walkSections(doc().sections)].map((s) => s.id);
    expect(ids).not.toContain('sec-2307.601/c');
    expect(ids).not.toContain('sec-2901.09/c');
  });

  it('never lets struck text reach a non-deleted chunk heading, breadcrumb or embedding', () => {
    const kept = spans(doc())
      .filter((span) => span.status !== 'deleted')
      .map((span) => normalize(span.text))
      .join(' ');
    // Struck words that also appear as kept text ("lawfully") cannot be told apart.
    const distinctive = [
      ...new Set(
        spans(doc())
          .filter((span) => span.status === 'deleted')
          .map((span) => normalize(span.text)),
      ),
    ].filter((text) => text.length > 3 && !kept.includes(text));
    expect(distinctive).toEqual(
      expect.arrayContaining([
        '(C) A trier of fact shall not consider the possibility of',
        'place in which',
      ]),
    );
    const chunks = chunkDocument(doc());
    expect(chunks.some((chunk) => chunk.amendmentStatus === 'deleted')).toBe(
      true,
    );
    for (const chunk of chunks.filter((c) => c.amendmentStatus !== 'deleted')) {
      const exposed = [chunk.heading ?? '', chunk.breadcrumb, chunk.embedText]
        .map(normalize)
        .join(' | ');
      for (const text of distinctive) expect(exposed).not.toContain(text);
    }
  });
});
