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
    // Each quoted section of the new article is a container inside bill section 1, and
    // its subdivisions nest under it (not under the previous section's last subdivision).
    const outline = [...walkSections(doc().sections)].map((s) => s.id);
    expect(outline).toEqual([
      'preamble',
      'sec-1',
      'sec-1/1509',
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `sec-1/1509/${String(n)}`),
      'sec-1/1510',
      ...[1, 2, 3].map((n) => `sec-1/1510/${String(n)}`),
      'sec-1/1511',
      ...[1, 2, 3].map((n) => `sec-1/1511/${String(n)}`),
      'sec-1/1512',
      'sec-1/1513',
      'sec-1/1514',
      ...[1, 2, 3, 4].map((n) => `sec-1/1514/${String(n)}`),
      'sec-2',
      'sec-3',
    ]);
    const definition = [...walkSections(doc().sections)].find(
      (s) => s.id === 'sec-1/1509/1',
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
    const ids = [...walkSections(doc().sections)].map((s) => s.id);
    expect(
      doc()
        .sections.map((s) => s.id)
        .filter((id) => id !== 'preamble'),
    ).toEqual(['sec-1', 'sec-2', 'sec-3', 'sec-4']);
    expect(ids).toEqual(expect.arrayContaining(['sec-1/1', 'sec-2/2']));
    const lawText = [...walkSections(doc().sections)]
      .map((s) => sectionText(s, { includeDeleted: false }))
      .join('\n');
    expect(lawText).not.toMatch(
      /superscript numerals|committee amendments adopted/,
    );
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

const insertedRuns = (doc: NormalizedDoc): string[] => {
  const runs: string[] = [];
  let current = '';
  for (const span of spans(doc)) {
    if (span.status === 'inserted') current += span.text;
    else if (span.text.trim() && current) {
      runs.push(normalize(current));
      current = '';
    }
  }
  if (current) runs.push(normalize(current));
  return runs;
};
describeWithFixture('nj-s1000-2024-r1', () => {
  const doc = load('nj-s1000-2024-r1');
  it('finds both counted deletions, all 5 underlined runs and no reprint-header false positive', () => {
    expect(deletionRuns(doc())).toEqual(['[deaf]', '[of a]']);
    expect(insertedRuns(doc())).toEqual([
      'hard of hearing',
      'as demonstrated by the',
      '500, 1,000, and 2,000 Hertz, of',
      'in the better ear, aided or unaided,',
      'or licensed by the State of New Jersey',
    ]);
    expect(doc().metadata).toMatchObject({
      billNumber: 'S. 1000',
      jurisdiction: 'New Jersey',
      session: '221st Legislature',
      version: 'First Reprint',
      sponsors: ['LINDA R. GREENSTEIN', 'PARKER SPACE'],
    });
    expect(doc().sections.map((s) => s.id)).toEqual([
      'preamble',
      'sec-1',
      'sec-2',
    ]);
  });
});
describeWithFixture('nj-s1000-2026-i1', () => {
  const doc = load('nj-s1000-2026-i1');
  it('reads an underline-only amendment with nested subsections', () => {
    expect(deletionRuns(doc())).toEqual([]);
    expect(insertedRuns(doc())).toEqual([
      'every current member of the New Jersey State Legislature while that person holds office,',
    ]);
    const ids = [...walkSections(doc().sections)].map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'sec-1',
        'sec-1/b/1/a',
        'sec-1/b/1/b/i',
        'sec-1/b/2/b',
        'sec-2',
      ]),
    );
    expect(doc().metadata).toMatchObject({
      billNumber: 'S. 1000',
      session: '222nd Legislature',
      version: 'Introduced',
    });
  });
});
describeWithFixture('nj-a3000-2026-i1', () => {
  const doc = load('nj-a3000-2026-i1');
  it('a new-law bill has no change marks at all', () => {
    expect(deletionRuns(doc())).toEqual([]);
    expect(insertedRuns(doc())).toEqual([]);
    expect(doc().metadata).toMatchObject({
      billNumber: 'A. 3000',
      jurisdiction: 'New Jersey',
      version: 'Introduced',
      sponsors: ['ERIK PETERSON'],
    });
    expect(doc().sections.map((s) => s.id)).toEqual(
      expect.arrayContaining(['sec-1', 'sec-2', 'sec-3', 'sec-4']),
    );
  });
});
describeWithFixture('ny-a5000-2025-assembly', () => {
  const doc = load('ny-a5000-2025-assembly');
  it('bill sections are the only containers; wrapped chapter lines are prose', () => {
    expect(doc().sections.map((s) => s.id)).toEqual([
      'preamble',
      'sec-1',
      'sec-2',
      'sec-3',
      'sec-4',
      'sec-5',
    ]);
    const all = [...walkSections(doc().sections)];
    expect(all.some((s) => s.id.startsWith('chapter-'))).toBe(false);
    expect(all.find((s) => s.id === 'sec-1')?.heading).toBe('Short Title.');
    expect(all.find((s) => s.id === 'sec-3')?.heading).toBeUndefined();
  });
});

describeWithFixture('nj-a4-2024-r2', () => {
  const doc = load('nj-a4-2024-r2');
  it('keeps all 39 bill sections; quoted statute sections are containers inside them', () => {
    const top = doc()
      .sections.map((s) => s.id)
      .filter((id) => id !== 'preamble');
    expect(top).toEqual(
      Array.from({ length: 39 }, (_, i) => `sec-${String(i + 1)}`),
    );
    const ids = [...walkSections(doc().sections)].map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(['sec-1/2', 'sec-2/4', 'sec-3/b', 'sec-4/13']),
    );
    // No section id is duplicated with a ~2 suffix inside the first seven bill sections.
    expect(
      ids.filter((id) => /^sec-[1-7]\//.test(id) && id.includes('~')),
    ).toEqual([]);
  });
  it('drops the superscript footnote from law text', () => {
    const text = [...walkSections(doc().sections)]
      .map((s) => sectionText(s, { includeDeleted: false }))
      .join('\n');
    expect(text).not.toMatch(
      /Matter enclosed in superscript|committee amendments adopted/,
    );
  });
});

const topLevel = (doc: NormalizedDoc) =>
  doc.sections.map((s) => s.id).filter((id) => id !== 'preamble');
const range = (count: number) =>
  Array.from({ length: count }, (_, i) => `sec-${String(i + 1)}`);

describeWithFixture('ny-a07601-2025-assembly', () => {
  const doc = load('ny-a07601-2025-assembly');
  it('the quoted "§ 3. This act shall take effect" stays inside bill section 1', () => {
    expect(topLevel(doc())).toEqual(['sec-1', 'sec-2']);
    expect(
      doc()
        .sections.find((s) => s.id === 'sec-1')
        ?.children.map((c) => c.num),
    ).toEqual(['§ 3']);
  });
});

describeWithFixture('ny-s07334-2025-assembly', () => {
  const doc = load('ny-s07334-2025-assembly');
  it('sections quoted from chapter 18 stay inside bill section 1', () => {
    expect(topLevel(doc())).toEqual(['sec-1', 'sec-2', 'sec-3']);
  });
});

describeWithFixture('ny-a06137-2025-assembly', () => {
  const doc = load('ny-a06137-2025-assembly');
  it('"section 11-2204" does not hide bill section 11', () => {
    expect(topLevel(doc())).toEqual(range(27));
  });
});

describeWithFixture('nj-a170-2024-i1', () => {
  const doc = load('nj-a170-2024-i1');
  it('opens bill section 7 on the first line of page 6', () => {
    expect(topLevel(doc())).toEqual([...range(7), 'article-statement']);
    const seven = doc().sections.find((s) => s.id === 'sec-7');
    expect(seven?.spans[0]?.page).toBe(6);
  });
});
