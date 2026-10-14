import { describe, expect, it } from 'vitest';
import { chunkDocument, estimateTokens } from '../chunk/index.js';
import {
  AppError,
  Chunk,
  Definition,
  ExternalRef,
  type NormalizedDoc,
} from '../model/index.js';
import { parseText } from '../parse/index.js';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { docOf, sec } from './fixtures.js';
import { enrichDocument } from './index.js';

/** Drops everything between `<` and `>` with a scan, so nested or broken tags cannot survive. */
function stripTags(markup: string): string {
  let out = '';
  let depth = 0;
  for (const ch of markup) {
    if (ch === '<') depth++;
    else if (ch === '>' && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

function run(doc: NormalizedDoc) {
  return enrichDocument(doc, chunkDocument(doc));
}

const ohio = docOf([
  sec('sec-5747.01', '', {
    num: '5747.01',
    heading: 'Definitions',
    spans: [
      {
        text: 'As used in this chapter:\n(A) "Adjusted gross income" means federal adjusted gross income as defined in section 62 of the Internal Revenue Code.\n(B) "Taxpayer" means any person subject to the tax imposed by section 5747.02 of the Revised Code.\n(C) "Fine" means a penalty under division (A) of this section.',
        status: 'unchanged',
      },
    ],
  }),
  sec(
    'sec-5747.02',
    'Taxpayer income is taxed. A taxpayer shall report adjusted gross income. See division (A) of section 5747.01 of the Revised Code and 42 U.S.C. 1983.',
    {
      num: '5747.02',
      heading: 'Levy',
    },
  ),
]);

describe('enrichDocument (Ohio Revised Code style)', () => {
  const { doc, chunks } = run(ohio);

  it('splits a definitions section so each definition is its own chunk', () => {
    const defs = chunks.filter((c) => c.chunkType === 'definition');
    expect(defs.map((c) => c.definesTerm)).toEqual([
      undefined,
      'Adjusted gross income',
      'Taxpayer',
      'Fine',
    ]);
    expect(defs[1]?.text).toMatch(/^\(A\) "Adjusted gross income" means/);
    expect(defs[1]?.text).not.toContain('Taxpayer');
    expect(defs[0]?.text).toBe('As used in this chapter:');
  });

  it('keeps chunks valid, ids deterministic and unique, embed text consistent', () => {
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    expect(chunks.map((c) => c.id.split(':').slice(1).join(':'))).toEqual([
      'sec-5747.01:0',
      'sec-5747.01:1',
      'sec-5747.01:2',
      'sec-5747.01:3',
      'sec-5747.02:0',
    ]);
    for (const c of chunks) {
      expect(() => Chunk.parse(c)).not.toThrow();
      expect(c.embedText).toBe(`${c.breadcrumb}: ${c.text}`);
      expect(c.tokenCount).toBe(estimateTokens(c.embedText));
      expect(c.tokenCount).toBeLessThanOrEqual(480);
    }
  });

  it('produces frozen-contract definitions with chapter scope', () => {
    expect(doc.definitions.map((d) => d.term)).toEqual([
      'Adjusted gross income',
      'Taxpayer',
      'Fine',
    ]);
    for (const d of doc.definitions) {
      expect(() => Definition.parse(d)).not.toThrow();
      expect(d).toMatchObject({ scope: 'document', sectionId: 'sec-5747.01' });
    }
  });

  it('fills definedTermsUsed with longest, whole-word, case-insensitive matches', () => {
    const levy = chunks.find((c) => c.sectionId === 'sec-5747.02');
    expect(levy?.definedTermsUsed).toEqual([
      'Taxpayer',
      'Adjusted gross income',
    ]);
    const taxpayerDef = chunks.find((c) => c.definesTerm === 'Taxpayer');
    expect(taxpayerDef?.definedTermsUsed).toEqual([]);
  });

  it('links references that resolve inside the document and collects external ones', () => {
    const levy = chunks.find((c) => c.sectionId === 'sec-5747.02');
    expect(levy?.refs).toEqual(['sec-5747.01']);
    // R.C. 5747.01/.02 are sections of this document, so they are internal, not external.
    expect(doc.externalRefs.map((r) => r.citation)).toEqual([
      '26 U.S.C. 62',
      '42 U.S.C. 1983',
    ]);
    for (const r of doc.externalRefs)
      expect(() => ExternalRef.parse(r)).not.toThrow();
    expect(
      doc.externalRefs.find((r) => r.citation === '42 U.S.C. 1983')?.sectionIds,
    ).toEqual(['sec-5747.02']);
    expect(
      doc.externalRefs.find((r) => r.citation === '26 U.S.C. 62')?.kind,
    ).toBe('us_code');
  });

  it('does not mutate its inputs and is idempotent', () => {
    const original = chunkDocument(ohio);
    const snapshot = JSON.stringify(original);
    const first = enrichDocument(ohio, original);
    expect(JSON.stringify(original)).toBe(snapshot);
    const second = enrichDocument(first.doc, first.chunks);
    expect(second.chunks).toEqual(first.chunks);
    expect(second.doc.definitions).toEqual(first.doc.definitions);
  });
});

describe('enrichDocument (federal style)', () => {
  const federal = docOf([
    sec('sec-2', 'In this Act:', {
      num: 'SEC. 2.',
      heading: 'DEFINITIONS.',
      children: [
        sec(
          'sec-2/1',
          'Administrator.—The term "Administrator" means the Administrator of the Small Business Administration.',
          { num: '(1)', level: 2 },
        ),
        sec(
          'sec-2/2',
          'Small business concern.—The term “small business concern” has the meaning given under section 3 of the Small Business Act (15 U.S.C. 632).',
          { num: '(2)', level: 2 },
        ),
      ],
    }),
    sec(
      'sec-3',
      'The Administrator shall issue rules for each small business concern under paragraph (1) of section 2 of this Act, consistent with 40 CFR 60 and Public Law 118-31.',
      {
        num: 'SEC. 3.',
        heading: 'RULES.',
      },
    ),
  ]);
  const { doc, chunks } = run(federal);

  it('detects headed federal definitions, one chunk each, with Act scope', () => {
    expect(doc.definitions.map((d) => [d.term, d.scope])).toEqual([
      ['Administrator', 'document'],
      ['small business concern', 'document'],
    ]);
    expect(
      chunks.filter((c) => c.definesTerm).map((c) => c.definesTerm),
    ).toEqual(['Administrator', 'small business concern']);
    expect(
      chunks.every(
        (c) => c.chunkType === 'definition' || c.sectionId === 'sec-3',
      ),
    ).toBe(true);
  });

  it('resolves internal refs and records external ones by kind', () => {
    const rules = chunks.find((c) => c.sectionId === 'sec-3');
    expect(rules?.definedTermsUsed).toEqual([
      'Administrator',
      'small business concern',
    ]);
    expect(rules?.refs).toEqual(['sec-2/1']);
    const kinds = Object.fromEntries(
      doc.externalRefs.map((r) => [r.citation, r.kind]),
    );
    expect(kinds).toMatchObject({
      '40 CFR 60': 'cfr',
      'Public Law 118-31': 'public_law',
      '15 U.S.C. 632': 'us_code',
    });
  });
});

describe('enrichDocument edge cases', () => {
  it('splits merged sibling subsections; each piece covers only the sections it holds', () => {
    const doc = docOf([
      sec('sec-1', '', {
        num: '1',
        heading: 'Terms',
        children: [
          sec('sec-1/a', '"Alpha" means the first. See subsection (b).', {
            num: '(a)',
            level: 2,
          }),
          sec('sec-1/b', '"Beta" means the second.', { num: '(b)', level: 2 }),
          sec('sec-1/c', 'The director shall act under section 2.', {
            num: '(c)',
            level: 2,
          }),
        ],
      }),
      sec('sec-2', 'Other.', { num: '2' }),
    ]);
    const merged = chunkDocument(doc);
    expect(merged[0]?.coveredSectionIds).toEqual([
      'sec-1',
      'sec-1/a',
      'sec-1/b',
      'sec-1/c',
    ]);
    const { chunks } = enrichDocument(doc, merged);
    const summary = chunks
      .filter((c) => c.sectionId === 'sec-1')
      .map((c) => [c.definesTerm, c.coveredSectionIds, c.refs]);
    expect(summary).toEqual([
      ['Alpha', ['sec-1', 'sec-1/a'], ['sec-1/b']],
      ['Beta', ['sec-1', 'sec-1/b'], []],
      [undefined, ['sec-1', 'sec-1/c'], ['sec-2']],
    ]);
  });

  it('keeps a chunk without merged children free of coveredSectionIds', () => {
    const { chunks } = run(docOf([sec('sec-1', 'Plain text. See section 2.')]));
    expect(chunks[0]?.coveredSectionIds).toBeUndefined();
    expect(chunks[0]?.refs).toEqual([]);
  });

  it('ends the last definition at the next non-definition label', () => {
    const doc = docOf([
      sec('sec-9', '', {
        num: '9',
        heading: 'Definitions',
        spans: [
          {
            text: 'As used in this section: (A) "Dependent child" means a person under eighteen. (B) "Employer" means any person that employs one or more individuals. (C) The director shall adopt rules under section 119.03 of the Revised Code.',
            status: 'unchanged',
          },
        ],
      }),
    ]);
    const { chunks, doc: out } = run(doc);
    const employer = chunks.find((c) => c.definesTerm === 'Employer');
    expect(employer?.text).toBe(
      '(B) "Employer" means any person that employs one or more individuals.',
    );
    expect(out.definitions.find((d) => d.term === 'Employer')?.text).toBe(
      employer?.text,
    );
    const rule = chunks.find((c) => c.text.startsWith('(C)'));
    expect(rule?.chunkType).toBe('operative');
    expect(rule?.definesTerm).toBeUndefined();
  });

  it('does not glue operative text onto a definition merged by the chunker', () => {
    const doc = docOf([
      sec('sec-1', '', {
        num: '1',
        children: [
          sec('sec-1/a', '"Alpha" means the first.', { num: '(a)', level: 2 }),
          sec('sec-1/b', '"Beta" means the second.', { num: '(b)', level: 2 }),
          sec('sec-1/c', 'The director shall act under paragraph (a).', {
            num: '(c)',
            level: 2,
          }),
        ],
      }),
    ]);
    const { chunks } = run(doc);
    expect(chunks.find((c) => c.definesTerm === 'Beta')?.text).toBe(
      '(b) "Beta" means the second.',
    );
    expect(chunks.at(-1)?.text).toContain('The director shall act');
  });

  it('records an Ohio cross-definition and its external citation', () => {
    const doc = docOf([
      sec('sec-2923.27', '', {
        num: '2923.27',
        spans: [
          {
            text: 'As used in this section:\n(1) "Federally licensed firearms dealer" has the same\nmeaning as in section 5502.63 of the Revised Code.\n(2) "Point of contact agency" shall have the same meanings as in section 2923.27 of the Revised Code.',
            status: 'unchanged',
          },
        ],
      }),
    ]);
    const { chunks, doc: out } = run(doc);
    expect(out.definitions.map((d) => d.term)).toEqual([
      'Federally licensed firearms dealer',
      'Point of contact agency',
    ]);
    expect(chunks.filter((c) => c.definesTerm).map((c) => c.chunkType)).toEqual(
      ['definition', 'definition'],
    );
    expect(out.externalRefs.map((r) => r.citation)).toContain('R.C. 5502.63');
  });

  it('puts operative text before a mid-section definition in its own chunk', () => {
    const doc = docOf([
      sec(
        'sec-1',
        'Employers shall register. "Employer" means a person who hires.',
      ),
    ]);
    const { chunks } = run(doc);
    expect(chunks.map((c) => [c.chunkType, c.definesTerm])).toEqual([
      ['operative', undefined],
      ['definition', 'Employer'],
    ]);
  });

  it('leaves deleted chunks untouched by definition splitting', () => {
    const doc = docOf([
      sec('sec-1', '', {
        spans: [
          { text: 'Kept text. ', status: 'unchanged' },
          {
            text: '"Old" means a struck definition. "Older" means another.',
            status: 'deleted',
          },
        ],
      }),
    ]);
    const { chunks, doc: out } = run(doc);
    const deleted = chunks.find((c) => c.amendmentStatus === 'deleted');
    expect(deleted?.definesTerm).toBeUndefined();
    expect(out.definitions).toEqual([]);
  });

  it('collapses a definition the chunker overlap repeated', () => {
    const filler = Array.from(
      { length: 330 },
      (_, i) => `word${String(i)}`,
    ).join(' ');
    const doc = docOf([
      sec('sec-1', `${filler}. "Tiny" means little. ${filler}.`, { num: '1' }),
    ]);
    const { chunks } = run(doc);
    expect(chunks.filter((c) => c.definesTerm === 'Tiny')).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(480);
  });

  it('keeps the longer copy when the overlap held a truncated definition', () => {
    const base = chunkDocument(docOf([sec('sec-1', 'x', { num: '1' })]))[0];
    if (!base) throw new Error('no chunk');
    const doc = docOf([sec('sec-1', 'x', { num: '1' })]);
    const mk = (text: string): Chunk => ({
      ...base,
      text,
      embedText: `${base.breadcrumb}: ${text}`,
    });
    const { chunks } = enrichDocument(doc, [
      mk('"Tiny" means little'),
      mk('"Tiny" means little and small.'),
    ]);
    expect(chunks.map((c) => c.text)).toEqual([
      '"Tiny" means little and small.',
    ]);
  });

  it('scopes section-limited terms to their section', () => {
    const doc = docOf([
      sec('sec-1', 'As used in this section, "Fee" means a charge.', {
        num: '1',
        children: [sec('sec-1/a', 'The fee is due.', { num: '(a)', level: 2 })],
      }),
      sec('sec-2', 'The fee is waived.', { num: '2' }),
    ]);
    const { chunks } = run(doc);
    expect(chunks.map((c) => [c.sectionId, c.definedTermsUsed])).toEqual([
      ['sec-1', []],
      ['sec-1/a', ['Fee']],
      ['sec-2', []],
    ]);
  });

  it('returns an empty list for no chunks, and rejects an invalid document', () => {
    expect(enrichDocument(docOf([]), []).chunks).toEqual([]);
    expect(() => enrichDocument({ ...ohio, docId: 'bad' }, [])).toThrow(
      AppError,
    );
  });
});

describe('enrichDocument at scale', () => {
  it('enriches a section of 800 definitions in under two seconds', () => {
    const text = `As used in this chapter:\n${Array.from(
      { length: 800 },
      (_, i) =>
        `(${String(i + 1)}) "Term ${String(i)}" means a person, place, or thing that is described at some length for the purposes of this chapter.`,
    ).join('\n')}`;
    const doc = docOf([
      sec('sec-1', text, { num: '1', heading: 'Definitions' }),
    ]);
    const input = chunkDocument(doc);
    const started = performance.now();
    const { chunks, doc: out } = enrichDocument(doc, input);
    const elapsed = performance.now() - started;
    expect(out.definitions).toHaveLength(800);
    expect(chunks.filter((c) => c.definesTerm)).toHaveLength(800);
    expect(elapsed).toBeLessThan(2000);
  });
});

describeWithFixture('oh-sb203-133-in', () => {
  it('finds the cross-definition and the numbered definitions in the real bill', async () => {
    const path = fixturePath('oh-sb203-133-in');
    if (!path) throw new Error('fixture missing');
    const pdf = await getDocument({
      data: new Uint8Array(readFileSync(path)),
    }).promise;
    let text = '';
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      for (const item of content.items)
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      text += '\n';
    }
    const doc = parseText(text, {
      sourceUrl: 'https://search-prod.lis.state.oh.us/bill.pdf',
      fetchedAt: '2026-10-13T00:00:00.000Z',
    });
    const { chunks, doc: out } = run(doc);
    const terms = out.definitions.map((d) => d.term);
    expect(terms).toEqual(
      expect.arrayContaining([
        'Federally licensed firearms dealer',
        'Gun show',
        'Gun show promoter',
        'Gun show vendor',
        'Transfer',
        'Unlicensed transferee',
        'Unlicensed transferor',
      ]),
    );
    expect(out.externalRefs.map((r) => r.citation)).toContain('R.C. 5502.63');
    // No definition swallows the next numbered item.
    for (const d of out.definitions) expect(d.text).not.toMatch(/\n\(\d+\) "/);
    for (const c of chunks) expect(() => Chunk.parse(c)).not.toThrow();
  });
});

describeWithFixture('us-s202-119-is-html', () => {
  it('enriches a real bill without breaking chunk invariants', () => {
    const path = fixturePath('us-s202-119-is-html');
    if (!path) throw new Error('fixture missing');
    const html = stripTags(readFileSync(path, 'utf8')).replace(/&nbsp;/g, ' ');
    const doc = parseText(html, {
      sourceUrl:
        'https://www.govinfo.gov/content/pkg/BILLS-119s202is/html/BILLS-119s202is.htm',
      fetchedAt: '2026-10-13T00:00:00.000Z',
    });
    const { chunks } = run(doc);
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    for (const c of chunks) {
      expect(() => Chunk.parse(c)).not.toThrow();
      expect(c.tokenCount).toBeLessThanOrEqual(480);
    }
  });
});
