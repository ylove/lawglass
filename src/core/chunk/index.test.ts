import { describe, expect, it } from 'vitest';
import {
  AppError,
  Chunk,
  EMPTY_METADATA,
  NormalizedDoc,
  makeChunkId,
  type Section,
  type Span,
} from '../model/index.js';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { chunkDocument, estimateTokens } from './index.js';

function section(id: string, text = '', over: Partial<Section> = {}): Section {
  return {
    id,
    level: 1,
    spans: [{ text, status: 'unchanged' }],
    children: [],
    ...over,
  };
}

function document(sections: Section[]): NormalizedDoc {
  return {
    docId: 'c'.repeat(64),
    sourceUrl: 'https://example.gov/bill.xml',
    format: 'xml',
    fetchedAt: '2026-10-13T00:00:00.000Z',
    metadata: { ...EMPTY_METADATA },
    sections,
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
}

function words(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, n) => `${prefix}_${String(n)}`).join(
    ' ',
  );
}

function expectError(doc: NormalizedDoc, code: string): void {
  expect(() => chunkDocument(doc)).toThrow(AppError);
  expect(() => chunkDocument(doc)).toThrow(expect.objectContaining({ code }));
}

describe('chunkDocument', () => {
  it('emits contextual embed text separately from raw text, with all metadata', () => {
    const doc = document([
      section('sec-4', '', {
        num: '4',
        children: [
          section('sec-4/b', '', {
            num: '(b)',
            level: 2,
            children: [
              section('sec-4/b/2', 'Applicants shall apply.', {
                num: '(2)',
                heading: 'Eligibility',
                level: 3,
              }),
            ],
          }),
        ],
      }),
    ]);
    const [chunk] = chunkDocument(doc);
    expect(chunk).toEqual({
      id: makeChunkId(doc.docId, 'sec-4/b/2', 0),
      docId: doc.docId,
      sectionId: 'sec-4/b/2',
      sectionNum: '(2)',
      heading: 'Eligibility',
      breadcrumb: 'Sec. 4 > (b) > (2) Eligibility',
      text: 'Applicants shall apply.',
      embedText: 'Sec. 4 > (b) > (2) Eligibility: Applicants shall apply.',
      tokenCount: estimateTokens(
        'Sec. 4 > (b) > (2) Eligibility: Applicants shall apply.',
      ),
      amendmentStatus: 'unchanged',
      chunkType: 'operative',
      definedTermsUsed: [],
      refs: [],
    });
    expect(Chunk.safeParse(chunk).success).toBe(true);
  });

  it('keeps parent-owned spans and top-level sections separate', () => {
    const chunks = chunkDocument(
      document([
        section('sec-1', 'Parent own text.', {
          children: [section('sec-1/a', 'Child own text.')],
        }),
        section('sec-2', 'Next section text.'),
      ]),
    );
    expect(chunks.map((chunk) => [chunk.sectionId, chunk.text])).toEqual([
      ['sec-1', 'Parent own text.'],
      ['sec-1/a', 'Child own text.'],
      ['sec-2', 'Next section text.'],
    ]);
  });

  it('merges adjacent small leaf siblings under their parent with span locations and child refs', () => {
    const doc = document([
      section('sec-4', 'Parent own text.', {
        num: 'Sec. 4',
        heading: 'Eligibility',
        children: [
          section('sec-4/a', '', {
            spans: [
              { text: 'First item. ', status: 'unchanged', page: 2, line: 28 },
              { text: 'New item.', status: 'inserted', page: 2, line: 29 },
            ],
          }),
          section('sec-4/b', '', {
            spans: [
              { text: 'Second item.', status: 'unchanged', page: 3, line: 2 },
            ],
          }),
        ],
      }),
    ]);
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({
      id: makeChunkId(doc.docId, 'sec-4', 1),
      sectionId: 'sec-4',
      text: 'First item. New item.\n\nSecond item.',
      breadcrumb: 'Sec. 4 Eligibility',
      amendmentStatus: 'inserted',
      pageStart: 2,
      pageEnd: 3,
      lineStart: 28,
      lineEnd: 2,
      refs: ['sec-4/a', 'sec-4/b'],
      definedTermsUsed: [],
    });
  });

  it('retains each merged child enumerator and heading inline in the excerpt', () => {
    const [chunk] = chunkDocument(
      document([
        section('sec-2', '', {
          num: '2',
          children: [
            section('sec-2/a', 'Residents may apply.', {
              num: '(a)',
              heading: 'Eligibility',
            }),
            section('sec-2/b', 'Apply by January 1.', {
              num: '(b)',
              heading: 'Deadline.',
            }),
            section('sec-2/c', 'Use the prescribed form.', { num: '(c)' }),
          ],
        }),
      ]),
    );
    expect(chunk).toMatchObject({
      sectionId: 'sec-2',
      text: '(a) Eligibility. Residents may apply.\n\n(b) Deadline. Apply by January 1.\n\n(c) Use the prescribed form.',
      refs: ['sec-2/a', 'sec-2/b', 'sec-2/c'],
    });
    expect(chunk?.embedText).toBe(`Sec. 2: ${chunk!.text}`);
  });

  it('limits sibling merges to the target and never merges through branches, empty leaves, or deletions', () => {
    const children = Array.from({ length: 5 }, (_, n) =>
      section(`sec-1/${String(n)}`, words(`s${String(n)}`, 100)),
    );
    children.splice(2, 0, section('sec-1/empty'));
    children.push(
      section('sec-1/deleted', '', {
        spans: [{ text: 'Removed.', status: 'deleted' }],
      }),
    );
    children.push(
      section('sec-1/branch', 'Branch own text.', {
        children: [section('sec-1/branch/a', 'Inner text.')],
      }),
    );
    const chunks = chunkDocument(
      document([section('sec-1', '', { children })]),
    );
    expect(
      chunks.some(
        (chunk) => chunk.text.includes('s1_0') && chunk.text.includes('s2_0'),
      ),
    ).toBe(false);
    expect(
      chunks.filter((chunk) => chunk.sectionId === 'sec-1').length,
    ).toBeGreaterThan(0);
    for (const chunk of chunks)
      expect(chunk.tokenCount).toBeLessThanOrEqual(450);
    expect(
      chunks.find((chunk) => chunk.sectionId === 'sec-1/deleted')
        ?.amendmentStatus,
    ).toBe('deleted');
    expect(
      chunks.find((chunk) => chunk.sectionId === 'sec-1/branch')?.text,
    ).toBe('Branch own text.');
  });

  it('groups consecutive deleted spans separately and joins adjacent normal spans without injecting spaces', () => {
    const chunks = chunkDocument(
      document([
        section('sec-1', '', {
          spans: [
            { text: 'Elig', status: 'unchanged' },
            { text: 'ible ', status: 'inserted' },
            { text: 'old ', status: 'deleted', page: 1, line: 1 },
            { text: 'requirement.', status: 'deleted', page: 1, line: 2 },
            { text: 'towns apply. ', status: 'unchanged', page: 2, line: 4 },
            { text: 'Other deletion.', status: 'deleted', page: 3, line: 8 },
          ],
        }),
      ]),
    );
    expect(chunks.map((chunk) => [chunk.text, chunk.amendmentStatus])).toEqual([
      ['Eligible towns apply.', 'inserted'],
      ['old requirement.', 'deleted'],
      ['Other deletion.', 'deleted'],
    ]);
    expect(chunks[0]).toMatchObject({
      pageStart: 2,
      pageEnd: 2,
      lineStart: 4,
      lineEnd: 4,
    });
    expect(chunks[1]).toMatchObject({
      pageStart: 1,
      pageEnd: 1,
      lineStart: 1,
      lineEnd: 2,
    });
  });

  it('prefers sentence boundaries above the minimum target', () => {
    const first = `${words('item', 160)}.`;
    const chunks = chunkDocument(
      document([section('sec-1', `${first} ${words('rest', 150)}`)]),
    );
    expect(estimateTokens(first)).toBeGreaterThanOrEqual(300);
    expect(chunks[0]?.text).toBe(first);
    expect(chunks[0]?.text.endsWith('.')).toBe(true);
  });

  it('uses at most 50 estimated tokens of whole-word overlap, covering all normal source text', () => {
    const text = words('word', 500);
    const chunks = chunkDocument(document([section('sec-1', text)]));
    expect(chunks.length).toBeGreaterThan(2);
    const rebuilt: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const current = chunk.text.split(' ');
      if (index === 0) rebuilt.push(...current);
      else {
        const previous = chunks[index - 1]!.text.split(' ');
        const overlapStart = previous.indexOf(current[0]!);
        const overlap = previous.slice(overlapStart);
        expect(overlapStart).toBeGreaterThanOrEqual(0);
        expect(estimateTokens(overlap.join(' '))).toBeLessThanOrEqual(50);
        expect(estimateTokens(overlap.join(' '))).toBeGreaterThanOrEqual(47);
        expect(current.slice(0, overlap.length)).toEqual(overlap);
        rebuilt.push(...current.slice(overlap.length));
      }
    }
    expect(rebuilt.join(' ')).toBe(text);
  });

  it('flags insertion only on chunks whose excerpt intersects the inserted span', () => {
    const chunks = chunkDocument(
      document([
        section('sec-1', '', {
          spans: [
            { text: `${words('keep', 400)} `, status: 'unchanged' },
            { text: `${words('new', 200)} `, status: 'inserted' },
            { text: words('after', 400), status: 'unchanged' },
          ],
        }),
      ]),
    );
    expect(chunks.some((chunk) => chunk.amendmentStatus === 'unchanged')).toBe(
      true,
    );
    for (const chunk of chunks)
      expect(chunk.amendmentStatus).toBe(
        chunk.text.includes('new_') ? 'inserted' : 'unchanged',
      );
  });

  it('splits large deleted runs under the same hard limit, with unique ids', () => {
    const chunks = chunkDocument(
      document([
        section('sec-1', '', {
          spans: [{ text: words('removed', 800), status: 'deleted' }],
        }),
      ]),
    );
    expect(chunks.length).toBeGreaterThan(3);
    expect(
      chunks.every(
        (chunk) =>
          chunk.amendmentStatus === 'deleted' && chunk.tokenCount <= 480,
      ),
    ).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });

  it('supports missing headings/numbers, printed section labels, and line-only locations', () => {
    const chunks = chunkDocument(
      document([
        section('fallback', 'Raw\n\ttext.', {
          spans: [{ text: 'Raw\n\ttext.', status: 'unchanged', line: 3 }],
        }),
        section('sec-2', 'Second.', { num: 'SECTION 2.' }),
        section('sec-3', 'Third.', { num: '§ 3' }),
        section('sec-4', 'Fourth.', { heading: 'Heading only' }),
      ]),
    );
    expect(chunks[0]).toMatchObject({
      breadcrumb: 'fallback',
      text: 'Raw\n\ttext.',
      lineStart: 3,
      lineEnd: 3,
    });
    expect(chunks[0]).not.toHaveProperty('pageStart');
    expect(chunks.slice(1).map((chunk) => chunk.breadcrumb)).toEqual([
      'SECTION 2.',
      '§ 3',
      'Heading only',
    ]);
  });

  it('returns no chunks for empty/whitespace-only documents or spans', () => {
    expect(chunkDocument(document([]))).toEqual([]);
    expect(
      chunkDocument(
        document([
          section('empty'),
          section('whitespace', ' \n '),
          section('deleted', '', { spans: [{ text: ' ', status: 'deleted' }] }),
        ]),
      ),
    ).toEqual([]);
  });

  it('shrinks overlap with a large breadcrumb and preserves words separated by huge whitespace', () => {
    const text = `${words('word', 400)}${' '.repeat(3000)}last`;
    const chunks = chunkDocument(
      document([section('sec-1', text, { heading: words('context', 145) })]),
    );
    expect(chunks.at(-1)?.text).toBe('last');
    for (const chunk of chunks)
      expect(chunk.tokenCount).toBeLessThanOrEqual(480);
    for (const word of text.match(/\S+/g) ?? [])
      expect(chunks.some((chunk) => chunk.text.includes(word))).toBe(true);
  });

  it('allows an indivisible word between the target and hard maximum', () => {
    const text = 'x'.repeat(1850);
    const [chunk] = chunkDocument(document([section('s', text)]));
    expect(chunk?.text).toBe(text);
    expect(chunk?.tokenCount).toBeGreaterThan(450);
    expect(chunk?.tokenCount).toBeLessThanOrEqual(480);
  });

  it('rejects invalid documents and duplicate section ids before chunking', () => {
    expectError({ ...document([]), docId: 'invalid' }, 'INVALID_INPUT');
    expectError(
      document([
        section('same'),
        section('parent', '', { children: [section('same')] }),
      ]),
      'INVALID_INPUT',
    );
  });

  it.each([2000, 50_000])(
    'hard-splits a %i-character token without losing text or aborting the document',
    (length) => {
      const text = '0123456789'.repeat(length / 10);
      for (const status of ['unchanged', 'deleted'] as const) {
        const chunks = chunkDocument(
          document([
            section('s', '', { spans: [{ text, status, page: 2, line: 3 }] }),
            section('next', 'The next section is still processed.'),
          ]),
        );
        const split = chunks.filter((chunk) => chunk.sectionId === 's');
        expect(split.length).toBeGreaterThan(1);
        expect(split.map((chunk) => chunk.text).join('')).toBe(text);
        for (const chunk of split) {
          expect(chunk.tokenCount).toBe(estimateTokens(chunk.embedText));
          expect(chunk.tokenCount).toBeLessThanOrEqual(480);
          expect(chunk).toMatchObject({
            amendmentStatus: status,
            pageStart: 2,
            pageEnd: 2,
            lineStart: 3,
            lineEnd: 3,
          });
          expect(Chunk.safeParse(chunk).success).toBe(true);
        }
        expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(
          chunks.length,
        );
        expect(chunks.at(-1)?.text).toBe(
          'The next section is still processed.',
        );
      }
    },
  );

  it('rejects unfit breadcrumbs and metadata rather than truncating citation context', () => {
    expectError(
      document([section('s', 'word', { heading: 'h'.repeat(2000) })]),
      'TOO_LARGE',
    );
    const heading = `${'😀'.repeat(400)}${'\u0000'.repeat(700)}`;
    expectError(
      document([section('s'.repeat(27_000), 'word', { heading })]),
      'TOO_LARGE',
    );
  });

  it('hard-splits Unicode tokens with contextual prefixes while preserving complete characters and locations', () => {
    const text = '😀'.repeat(2000);
    const chunks = chunkDocument(
      document([
        section('s', '', {
          heading: 'Context',
          spans: [
            {
              text: text.slice(0, 2000),
              status: 'unchanged',
              page: 1,
              line: 5,
            },
            { text: text.slice(2000), status: 'inserted', page: 2, line: 6 },
          ],
        }),
      ]),
    );
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(480);
      expect(chunk.text).toMatch(/^(?:😀)+$/u);
    }
    expect(chunks[0]).toMatchObject({
      amendmentStatus: 'unchanged',
      pageStart: 1,
      pageEnd: 1,
    });
    expect(chunks[1]).toMatchObject({
      amendmentStatus: 'inserted',
      pageStart: 1,
      pageEnd: 2,
    });
    expect(chunks.at(-1)).toMatchObject({
      amendmentStatus: 'inserted',
      pageStart: 2,
      pageEnd: 2,
    });
  });

  it('round-trips chunks through MemoryBackend and keeps deleted chunks out of normal filters', async () => {
    const doc = document([
      section('sec-1', '', {
        spans: [
          { text: 'Current town requirement.', status: 'unchanged' },
          { text: 'Deleted town requirement.', status: 'deleted' },
          { text: ' New town requirement.', status: 'inserted' },
        ],
      }),
    ]);
    const chunks = chunkDocument(doc);
    const backend = new MemoryBackend();
    await backend.upsertChunks(doc.docId, chunks);
    await backend.upsertChunks(doc.docId, chunks);
    const stored = await backend.getChunks(
      doc.docId,
      chunks.map((chunk) => chunk.id),
    );
    expect(stored).toEqual(
      chunks.map(({ embedText: _omit, ...metadata }) => metadata),
    );
    for (const index of ['dense', 'sparse'] as const) {
      const { hits } = await backend.search({
        docId: doc.docId,
        index,
        query: 'town requirement',
        topK: 10,
        filter: { amendmentStatus: ['unchanged', 'inserted'] },
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.chunk.text).not.toContain('Deleted');
    }
  });
});

/** Seeded generation makes failures reproducible without a property-testing dependency. */
function generatedDoc(seed: number): NormalizedDoc {
  let state = seed + 1;
  const random = (max: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  let serial = 0;
  function node(parent: string, level: number): Section {
    const id = `${parent}/s${String(serial++)}`;
    const spans: Span[] = Array.from(
      { length: 1 + random(6) },
      (_, spanIndex) => {
        const status = (['unchanged', 'inserted', 'deleted'] as const)[
          random(3)
        ]!;
        const marker = `${id.replaceAll('/', '_')}_${status}_${String(spanIndex)}`;
        const count = random(130);
        return {
          text: `${words(marker, count)}${count ? '. ' : ''}`,
          status,
          page: 1 + Math.floor(spanIndex / 3),
          line: 1 + (spanIndex % 3),
        };
      },
    );
    return section(id, '', {
      level,
      num: level === 1 ? String(serial) : `(${String(serial)})`,
      heading: seed % 2 ? 'Eligibility' : undefined,
      spans,
      children:
        level < 3
          ? Array.from({ length: random(4) }, () => node(id, level + 1))
          : [],
    });
  }
  return document(Array.from({ length: 1 + random(3) }, () => node('root', 1)));
}

describe('generated document properties', () => {
  it.each(Array.from({ length: 40 }, (_, seed) => seed))(
    'preserves chunk invariants for seed %i',
    (seed) => {
      const doc = generatedDoc(seed);
      expect(NormalizedDoc.safeParse(doc).success).toBe(true);
      const before = JSON.stringify(doc);
      const chunks = chunkDocument(doc);
      expect(JSON.stringify(chunkDocument(doc))).toBe(JSON.stringify(chunks));
      expect(JSON.stringify(doc)).toBe(before);
      expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
      const sections: Section[] = [];
      const collect = (nodes: Section[]): void => {
        for (const node of nodes) {
          sections.push(node);
          collect(node.children);
        }
      };
      collect(doc.sections);
      const sourceOwners = new Map<string, Section>();
      for (const node of sections)
        for (const span of node.spans)
          for (const word of span.text.match(/\S+/g) ?? [])
            sourceOwners.set(word, node);
      const counters = new Map<string, number>();
      for (const chunk of chunks) {
        expect(Chunk.safeParse(chunk).success).toBe(true);
        expect(chunk.id).toBe(
          makeChunkId(
            doc.docId,
            chunk.sectionId,
            counters.get(chunk.sectionId) ?? 0,
          ),
        );
        counters.set(chunk.sectionId, (counters.get(chunk.sectionId) ?? 0) + 1);
        expect(chunk.tokenCount).toBe(estimateTokens(chunk.embedText));
        expect(chunk.tokenCount).toBeLessThanOrEqual(480);
        const { embedText: _omit, ...metadata } = chunk;
        expect(
          Buffer.byteLength(JSON.stringify(metadata), 'utf8'),
        ).toBeLessThan(30_000);
        const mergedLabels = new Set(
          sections
            .filter((node) => chunk.refs.includes(node.id))
            .flatMap((node) =>
              [node.num ?? '', node.heading ? `${node.heading}.` : '']
                .join(' ')
                .split(/\s+/),
            ),
        );
        for (const word of chunk.text.split(/\s+/))
          expect(sourceOwners.has(word) || mergedLabels.has(word)).toBe(true);
        const owners = [
          ...new Set(
            chunk.text.split(/\s+/).flatMap((word) => {
              const owner = sourceOwners.get(word);
              return owner ? [owner] : [];
            }),
          ),
        ];
        expect(owners.length).toBeGreaterThan(0);
        expect(owners).not.toContain(undefined);
        if (owners.length === 1) expect(owners[0]?.id).toBe(chunk.sectionId);
        else {
          const parent = sections.find((node) => node.id === chunk.sectionId)!;
          expect(
            owners.every(
              (node) =>
                parent.children.includes(node) && node.children.length === 0,
            ),
          ).toBe(true);
          expect(chunk.amendmentStatus).not.toBe('deleted');
        }
        expect(chunk.text.includes('_deleted_')).toBe(
          chunk.amendmentStatus === 'deleted',
        );
        if (chunk.amendmentStatus !== 'deleted')
          expect(chunk.amendmentStatus === 'inserted').toBe(
            chunk.text.includes('_inserted_'),
          );
      }
      // Every original word remains represented in its appropriate amendment stream.
      const normalWords = new Set(
        chunks
          .filter((c) => c.amendmentStatus !== 'deleted')
          .flatMap((c) => c.text.split(/\s+/)),
      );
      const deletedWords = new Set(
        chunks
          .filter((c) => c.amendmentStatus === 'deleted')
          .flatMap((c) => c.text.split(/\s+/)),
      );
      for (const node of sections)
        for (const span of node.spans)
          for (const word of span.text.match(/\S+/g) ?? [])
            expect(
              (span.status === 'deleted' ? deletedWords : normalWords).has(
                word,
              ),
            ).toBe(true);
    },
  );
});
