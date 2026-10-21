import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import {
  hasAmendmentMarks,
  MAX_CHANGED_SECTIONS,
  MAX_CHANGE_EXCERPT_CHARS,
  pickFairly,
} from './chip-changes.js';
import { getChip, runChip } from './chips.js';
import type { ChipDeps } from './chip-types.js';
import {
  EMPTY_METADATA,
  type SearchHit,
  type Section,
  type Span,
  type TextRequest,
} from './model/index.js';

const DOC = 'e'.repeat(64);

const section = (
  id: string,
  spans: Span[],
  over: Partial<Section> = {},
): Section => ({ id, level: 1, spans, children: [], ...over });

const mark =
  (status: Span['status']) =>
  (text: string, page?: number, line?: number): Span => ({
    text,
    status,
    ...(page && { page }),
    ...(line && { line }),
  });
const same = mark('unchanged');
const struck = mark('deleted');
const added = mark('inserted');

const userOf = (req: TextRequest): string => req.messages[0]!.content;
const lastPrompt = (p: ScriptedProvider): string =>
  userOf(p.calls.at(-1) as TextRequest);

/** Parsed `<excerpt ...>` elements of the last prompt: section, status, heading, text. */
function excerptsOf(p: ScriptedProvider) {
  return [
    ...lastPrompt(p).matchAll(
      /<excerpt id="\d+" section="([^"]+)" heading="([^"]*)" status="([^"]+)"[^>]*>([^<]*)<\/excerpt>/g,
    ),
  ].map((m) => ({
    section: m[1]!,
    heading: m[2]!,
    status: m[3]!,
    text: m[4]!,
  }));
}

function makeDeps(sections: Section[], provider: ScriptedProvider): ChipDeps {
  return {
    backend: new MemoryBackend(),
    provider,
    doc: { metadata: EMPTY_METADATA, sections },
  };
}

const run = (sections: Section[], provider: ScriptedProvider, opts = {}) =>
  runChip(getChip('what-changes'), DOC, makeDeps(sections, provider), opts);

/** Shape of Ohio HB 62 sec-2307.601/b: amended word by word inside one sentence. */
const retreat = section('sec-2307.601', [same('Intro text. ')], {
  num: '2307.601',
  heading: 'Duty to retreat',
  children: [
    section(
      'sec-2307.601/b',
      [
        same('An unchanged first sentence. A person in a '),
        struck('place in which'),
        added('vehicle owned by a family member of'),
        same(' the person '),
        struck('lawfully'),
        added(', the person'),
        same(' has '),
        struck('a right'),
        added('no duty'),
        same(' to '),
        struck('be'),
        added('retreat'),
        same(' before using force. A closing unchanged sentence.'),
      ],
      { num: '(b)', level: 2 },
    ),
  ],
});

describe('what-changes chip (built from spans)', () => {
  it('gives each change its sentence as a before/after pair with the changed words marked', async () => {
    const provider = new ScriptedProvider({
      reply: 'It changes [S:sec-2307.601/b].',
    });
    const r = await run([retreat], provider);
    const ex = excerptsOf(provider);
    expect(ex.map((e) => [e.section, e.status])).toEqual([
      ['sec-2307.601/b', 'deleted'],
      ['sec-2307.601/b', 'inserted'],
    ]);
    expect(ex[0]!.text).toBe(
      'A person in a [-place in which-] the person [-lawfully-] has [-a right-] to [-be-] before using force.',
    );
    expect(ex[1]!.text).toBe(
      'A person in a [+vehicle owned by a family member of+] the person [+, the person+] has [+no duty+] to [+retreat+] before using force.',
    );
    // Sentences without a change are left out.
    expect(lastPrompt(provider)).not.toContain('unchanged first sentence');
    expect(lastPrompt(provider)).not.toContain('Intro text');
    // Struck words appear only in the deleted excerpt, new words only in the inserted one.
    expect(ex[1]!.text).not.toMatch(/place in which|lawfully|a right/);
    expect(ex[0]!.text).not.toMatch(/no duty|retreat|vehicle/);
    expect(lastPrompt(provider)).toContain('Only the marked words changed');
    expect(r.answer.invalidCitations).toEqual([]);
  });

  it('builds breadcrumbs from the ancestor path, never "Sec. (b)"', async () => {
    const provider = new ScriptedProvider({ reply: 'x [S:sec-2307.601/b].' });
    await run([retreat], provider);
    const [first] = excerptsOf(provider);
    expect(first!.heading).toBe('Sec. 2307.601 Duty to retreat &gt; (b)');
    expect(lastPrompt(provider)).not.toContain('Sec. (b)');
  });

  it('shows a pure insertion only as an AFTER sentence and a pure strike only as BEFORE', async () => {
    const provider = new ScriptedProvider({ reply: 'x [S:sec-1].' });
    await run(
      [
        section('sec-1', [
          same('Keep this. Remove '),
          struck('this word'),
          same(' now. Add '),
          added('that word'),
          same(' here.'),
        ]),
      ],
      provider,
    );
    expect(excerptsOf(provider).map((e) => [e.status, e.text])).toEqual([
      ['deleted', 'Remove [-this word-] now.'],
      ['inserted', 'Add [+that word+] here.'],
    ]);
  });

  it('collapses a newly enacted section to one excerpt so amended sections still appear (SB 203 shape)', async () => {
    const newSection = section(
      'sec-2923.27',
      [added('Offenses involving the new thing. ')],
      {
        num: '2923.27',
        heading: 'New offense',
        children: Array.from({ length: 74 }, (_, i) =>
          section(
            `sec-2923.27/${String(i)}`,
            [added(`New rule ${String(i)}.`)],
            {
              num: `(${String(i)})`,
            },
          ),
        ),
      },
    );
    const fines = section('sec-2929.28', [], {
      num: '2929.28',
      heading: 'Fines',
      children: [
        section(
          'sec-2929.28/a',
          [same('The fine is '), struck('$1,000'), added('$5,000'), same('.')],
          { num: '(A)' },
        ),
      ],
    });
    const other = section(
      'sec-5122.311',
      [same('A hospital '), struck('may'), added('shall'), same(' report.')],
      { num: '5122.311' },
    );
    const provider = new ScriptedProvider({ reply: 'x [S:sec-2929.28/a].' });
    const r = await run([newSection, fines, other], provider);
    const ex = excerptsOf(provider);
    expect(ex.map((e) => e.section)).toEqual([
      'sec-2923.27',
      'sec-2929.28/a',
      'sec-2929.28/a',
      'sec-5122.311',
      'sec-5122.311',
    ]);
    expect(ex[0]!.text).toMatch(
      /^Newly enacted: all of this section's text is new \(74 subdivisions\)\. It begins: \[\+Offenses involving the new thing\./,
    );
    expect(ex[0]!.status).toBe('inserted');
    expect(ex[1]!.text).toBe('The fine is [-$1,000-].');
    expect(r.answer.text).not.toContain('not covered');
  });

  it('collapses a wholly new subtree inside an amended section', async () => {
    const tree = section(
      'sec-1',
      [same('Old '), added('new'), same(' text.')],
      {
        children: [
          section('sec-1/z', [added('Whole new subsection.')], { num: '(Z)' }),
        ],
      },
    );
    const provider = new ScriptedProvider({ reply: 'x [S:sec-1].' });
    await run([tree], provider);
    expect(excerptsOf(provider).map((e) => e.text)).toEqual([
      'Old [+new+] text.',
      "Newly enacted: all of this section's text is new. It begins: [+Whole new subsection.+]",
    ]);
  });

  it('shares the budget round-robin across top-level sections and says how many more change', async () => {
    const amended = (n: number): Section =>
      section(`sec-${String(n)}`, [
        same('Law '),
        struck(`old${String(n)}`),
        same('.'),
      ]);
    // 1 section with 40 changed subsections, then 12 single-change sections.
    const big = section('sec-big', [], {
      children: Array.from({ length: 40 }, (_, i) =>
        section(`sec-big/${String(i)}`, [added(`n${String(i)} `), same('x.')]),
      ),
    });
    const tree = [big, ...Array.from({ length: 12 }, (_, i) => amended(i))];
    const provider = new ScriptedProvider({ reply: 'x [S:sec-0].' });
    const tokens: string[] = [];
    const r = await run(tree, provider, {
      onToken: (t: string) => tokens.push(t),
    });
    const sections = excerptsOf(provider).map((e) => e.section);
    // Every small section is covered; the big one gets the remaining slots.
    for (let i = 0; i < 12; i++) expect(sections).toContain(`sec-${String(i)}`);
    expect(new Set(sections.map((s) => s.split('/')[0])).size).toBe(13);
    expect(r.answer.text).toMatch(
      /\n\n27 more changed sections are not covered here\.$/,
    );
    expect(tokens.join('')).toContain('27 more changed sections');
    // Shown in document order: the big section comes first.
    expect(sections[0]).toMatch(/^sec-big/);
  });

  it('uses singular wording for one hidden section', async () => {
    const tree = Array.from({ length: MAX_CHANGED_SECTIONS + 1 }, (_, i) =>
      section(`sec-${String(i + 1)}`, [
        added(`New ${String(i)}`),
        same(' end.'),
      ]),
    );
    const provider = new ScriptedProvider({ reply: 'x [S:sec-1].' });
    const r = await run(tree, provider);
    expect(r.answer.text).toContain(
      '1 more changed section is not covered here.',
    );
  });

  it('takes citation locations from the shown sentences', async () => {
    const provider = new ScriptedProvider({
      reply: 'It strikes a rule [S:sec-9] and adds one [S:sec-9].',
    });
    const tree = [
      section('sec-9', [
        same('Intro. ', 1, 1),
        same('Keep ', 2, 4),
        struck('old part', 2, 5),
        added('new part', 3, 2),
        same(' end.'),
      ]),
    ];
    const r = await run(tree, provider);
    expect(r.answer.invalidCitations).toEqual([]);
    expect(r.answer.citations[0]?.location).toMatchObject({
      pageStart: 2,
      pageEnd: 3,
      lineStart: 4,
    });
  });

  it('falls back to the section page range when spans carry no location', async () => {
    const provider = new ScriptedProvider({ reply: 'a [S:sec-1].' });
    const tree = [
      section('sec-1', [struck('gone'), same(' x.')], {
        pageStart: 7,
        pageEnd: 8,
      }),
    ];
    const r = await run(tree, provider);
    expect(r.answer.citations[0]?.location).toMatchObject({
      pageStart: 7,
      pageEnd: 8,
    });
  });

  it('never returns synthetic chunk ids in citations or hits', async () => {
    const provider = new ScriptedProvider({ reply: 'a [S:sec-2307.601/b].' });
    const r = await run([retreat], provider);
    expect(r.hits).toEqual([]);
    expect(r.mode).toBe('none');
    for (const c of r.answer.citations) {
      expect(c.chunkIds.some((id) => id.includes(':~'))).toBe(false);
    }
  });

  it('truncates one huge sentence so it cannot crowd out other sections', async () => {
    const provider = new ScriptedProvider({ reply: 'x [S:sec-1].' });
    await run(
      [section('sec-1', [struck('w'.repeat(MAX_CHANGE_EXCERPT_CHARS * 3))])],
      provider,
    );
    const [e] = excerptsOf(provider);
    expect(e!.text.length).toBe(MAX_CHANGE_EXCERPT_CHARS + 1); // plus the ellipsis
    expect(e!.text.endsWith('…')).toBe(true);
  });

  it('stops adding sentences to an excerpt at the character cap', async () => {
    const spans: Span[] = Array.from({ length: 10 }, (_, i) => [
      same('Keep. '),
      struck(`${'z'.repeat(600)}${String(i)}`),
      same(' end. '),
    ]).flat();
    const provider = new ScriptedProvider({ reply: 'x [S:sec-1].' });
    await run([section('sec-1', spans)], provider);
    const [e] = excerptsOf(provider);
    expect(e!.text.endsWith('\n…')).toBe(true);
    expect(e!.text.length).toBeLessThanOrEqual(MAX_CHANGE_EXCERPT_CHARS + 2);
  });

  it('falls back to instruction retrieval when nothing is marked up, and declines without a model call if that finds nothing', async () => {
    const provider = new ScriptedProvider();
    const r = await run([section('sec-1', [same('Plain.')])], provider);
    expect(r.answer.declined).toBe(true);
    expect(provider.calls).toHaveLength(0);
    expect(r.mode).toBe('hybrid');
  });

  it('ignores blank runs when deciding whether a section changed', async () => {
    const provider = new ScriptedProvider();
    const r = await run(
      [section('sec-1', [same('x.'), struck('   '), added('')])],
      provider,
    );
    expect(r.answer.declined).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('pickFairly', () => {
  const entry = (name: string): SearchHit[] => [
    { chunk: { id: name } as SearchHit['chunk'], score: 1 },
  ];
  it('takes one entry per group in turn and keeps document order', () => {
    const groups = [
      ['a1', 'a2', 'a3', 'a4', 'a5'].map(entry),
      [entry('b1')],
      [entry('c1')],
    ];
    const { picked, hidden } = pickFairly(groups, 5);
    expect(picked.map((h) => h.chunk.id)).toEqual([
      'a1',
      'a2',
      'a3',
      'b1',
      'c1',
    ]);
    expect(hidden).toBe(2);
  });
  it('shows everything when under budget', () => {
    expect(pickFairly([[entry('a')], [entry('b')]], 10)).toMatchObject({
      hidden: 0,
    });
    expect(pickFairly([], 10)).toEqual({ picked: [], hidden: 0 });
  });
});

describe('hasAmendmentMarks', () => {
  it('is true for a nested marked change and false for plain text', () => {
    expect(hasAmendmentMarks([retreat])).toBe(true);
    expect(hasAmendmentMarks([section('sec-1', [same('Plain.')])])).toBe(false);
    expect(hasAmendmentMarks([])).toBe(false);
  });
});

describe('what-changes on a scan with unreliable marks', () => {
  const scanned = (marks: 'read' | 'uncertain' | 'not-read') => ({
    pages: [
      { page: 1, marks: 'read' as const },
      { page: 2, marks },
    ],
  });
  const runWith = (
    sections: Section[],
    marks: 'read' | 'uncertain' | 'not-read',
    provider: ScriptedProvider,
  ) =>
    runChip(
      getChip('what-changes'),
      DOC,
      {
        ...makeDeps(sections, provider),
        doc: {
          metadata: EMPTY_METADATA,
          sections,
          scan: scanned(marks),
        },
      },
      {},
    );

  it.each(['uncertain', 'not-read'] as const)(
    'with no detected changes and marks %s, says it may be incomplete and never calls it "no changes"',
    async (marks) => {
      const provider = new ScriptedProvider({ reply: 'No changes.' });
      const r = await runWith(
        [section('sec-1', [same('Plain.')])],
        marks,
        provider,
      );
      expect(r.answer.text).toMatch(/may be incomplete/);
      expect(r.answer.text).not.toMatch(/no changes/i);
      expect(r.answer.declined).toBe(false);
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('appends the caveat to a real answer when some changes were found', async () => {
    const provider = new ScriptedProvider({
      reply: 'It changes [S:sec-2307.601/b].',
    });
    const r = await runWith([retreat], 'uncertain', provider);
    expect(r.answer.text).toContain('It changes');
    expect(r.answer.text).toMatch(/may be incomplete/);
  });

  it('adds nothing when every page was read', async () => {
    const provider = new ScriptedProvider({
      reply: 'It changes [S:sec-2307.601/b].',
    });
    const r = await runWith([retreat], 'read', provider);
    expect(r.answer.text).not.toMatch(/incomplete/);
  });
});
