import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import {
  MAX_CHANGED_SECTIONS,
  MAX_CHANGE_EXCERPT_CHARS,
} from './chip-changes.js';
import { getChip, runChip } from './chips.js';
import type { ChipDeps } from './chip-types.js';
import {
  EMPTY_METADATA,
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

const same = (text: string, page?: number, line?: number): Span => ({
  text,
  status: 'unchanged',
  ...(page && { page }),
  ...(line && { line }),
});
const struck = (text: string, page?: number, line?: number): Span => ({
  text,
  status: 'deleted',
  ...(page && { page }),
  ...(line && { line }),
});
const added = (text: string, page?: number, line?: number): Span => ({
  text,
  status: 'inserted',
  ...(page && { page }),
  ...(line && { line }),
});

/** Mixed bill: every third section is unchanged, struck-only, or both struck and underlined. */
function mixedBill(n: number): Section[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `sec-${String(i + 1)}`;
    const base = same(
      `Existing law ${id}. `,
      1 + Math.floor(i / 10),
      1 + (i % 10),
    );
    if (i % 3 === 0) return section(id, [base]);
    if (i % 3 === 1)
      return section(id, [base, struck(`OLD ${id} wording`), same(' end.')]);
    return section(id, [
      base,
      struck(`OLD ${id} wording`),
      added(`NEW ${id} wording`),
    ]);
  });
}

const userOf = (req: TextRequest): string => req.messages[0]!.content;
const lastPrompt = (p: ScriptedProvider): string =>
  userOf(p.calls.at(-1) as TextRequest);

function makeDeps(sections: Section[], provider: ScriptedProvider): ChipDeps {
  return {
    backend: new MemoryBackend(),
    provider,
    doc: { metadata: EMPTY_METADATA, sections },
  };
}

describe('what-changes chip (built from spans)', () => {
  it('shows one deleted and one inserted excerpt per changed section, in document order', async () => {
    const provider = new ScriptedProvider({ reply: 'Changes [S:sec-2].' });
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(mixedBill(9), provider),
    );
    const prompt = lastPrompt(provider);
    // Unchanged sections (sec-1, sec-4, sec-7) and unchanged text never reach the prompt.
    expect(prompt).not.toContain('section="sec-1"');
    expect(prompt).not.toContain('Existing law');
    expect(prompt).not.toContain(' end.');
    expect(
      [...prompt.matchAll(/section="([^"]+)"[^>]*status="([^"]+)"/g)].map(
        (m) => `${m[1] ?? ''}:${m[2] ?? ''}`,
      ),
    ).toEqual([
      'sec-2:deleted',
      'sec-3:deleted',
      'sec-3:inserted',
      'sec-5:deleted',
      'sec-6:deleted',
      'sec-6:inserted',
      'sec-8:deleted',
      'sec-9:deleted',
      'sec-9:inserted',
    ]);
    // Each excerpt holds exactly its own runs.
    expect(prompt).toContain('>OLD sec-3 wording</excerpt>');
    expect(prompt).toContain('>NEW sec-3 wording</excerpt>');
    expect(run.hits).toHaveLength(9);
    expect(prompt).toContain('Group your answer by section');
  });

  it('never presents struck text as live or underlined text as struck', async () => {
    const provider = new ScriptedProvider({ reply: 'x [S:sec-3].' });
    await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(mixedBill(3), provider),
    );
    const excerpts = [
      ...lastPrompt(provider).matchAll(
        /status="([^"]+)"[^>]*>([^<]*)<\/excerpt>/g,
      ),
    ];
    for (const [, status, text] of excerpts) {
      if (text!.startsWith('OLD')) expect(status).toBe('deleted');
      if (text!.startsWith('NEW')) expect(status).toBe('inserted');
      expect(status).not.toBe('unchanged');
    }
  });

  it('takes citation locations from the spans', async () => {
    const provider = new ScriptedProvider({
      reply: 'It strikes a rule [S:sec-9] and adds one [S:sec-9].',
    });
    const tree = [
      section('sec-9', [
        same('Intro. ', 1, 1),
        struck('old part one', 2, 5),
        same(' mid '),
        struck('old part two', 2, 9),
        added('new part', 3, 2),
      ]),
    ];
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(tree, provider),
    );
    const [deleted, inserted] = run.hits;
    expect(deleted?.chunk.text).toBe('old part one … old part two');
    expect(deleted?.chunk).toMatchObject({
      pageStart: 2,
      pageEnd: 2,
      lineStart: 5,
      lineEnd: 9,
    });
    expect(inserted?.chunk).toMatchObject({
      pageStart: 3,
      pageEnd: 3,
      lineStart: 2,
      lineEnd: 2,
    });
    expect(run.answer.invalidCitations).toEqual([]);
    expect(run.answer.citations[0]?.location).toMatchObject({
      pageStart: 2,
      lineStart: 5,
    });
  });

  it('omits the last line when a run spans pages, and falls back to the section range', async () => {
    const provider = new ScriptedProvider({ reply: 'a [S:sec-1].' });
    const tree = [
      section(
        'sec-1',
        [struck('a', 1, 20), same('-'), struck('b', 2, 3), added('plain')],
        { pageStart: 7, pageEnd: 8, num: '1', heading: 'Rules' },
      ),
    ];
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(tree, provider),
    );
    const [deleted, inserted] = run.hits;
    expect(deleted?.chunk).toMatchObject({
      pageStart: 1,
      pageEnd: 2,
      lineStart: 20,
    });
    expect(deleted?.chunk.lineEnd).toBeUndefined();
    expect(deleted?.chunk.breadcrumb).toBe('Sec. 1 > Rules');
    // No page/line on the underlined run: the section's own range is used.
    expect(inserted?.chunk).toMatchObject({ pageStart: 7, pageEnd: 8 });
  });

  it('merges adjacent spans of one status into one run and ignores blank runs', async () => {
    const provider = new ScriptedProvider({ reply: 'a [S:sec-1].' });
    const tree = [
      section('sec-1', [
        struck('one '),
        struck('two'),
        same('x'),
        struck('  '),
      ]),
    ];
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(tree, provider),
    );
    expect(run.hits.map((h) => h.chunk.text)).toEqual(['one two']);
  });

  it('finds changes in nested subsections', async () => {
    const provider = new ScriptedProvider({ reply: 'a [S:sec-1/a].' });
    const tree = [
      section('sec-1', [same('Top.')], {
        children: [section('sec-1/a', [added('Nested new text.')])],
      }),
    ];
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(tree, provider),
    );
    expect(run.hits.map((h) => h.chunk.sectionId)).toEqual(['sec-1/a']);
  });

  it('caps the sections shown and says how many more change', async () => {
    const provider = new ScriptedProvider({ reply: 'Many changes [S:sec-2].' });
    const tokens: string[] = [];
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(mixedBill(3 * (MAX_CHANGED_SECTIONS + 4)), provider),
      { onToken: (t) => tokens.push(t) },
    );
    const sections = new Set(run.hits.map((h) => h.chunk.sectionId));
    expect(sections.size).toBe(MAX_CHANGED_SECTIONS);
    // 2 of every 3 sections change: 2 * 29 = 58 changed, 25 shown.
    expect(run.answer.text).toMatch(
      /\n\n33 more sections also change and are not covered here\.$/,
    );
    expect(tokens.join('')).toContain('33 more sections also change');
  });

  it('uses singular wording for one hidden section', async () => {
    const provider = new ScriptedProvider({ reply: 'x [S:sec-1].' });
    const tree = Array.from({ length: MAX_CHANGED_SECTIONS + 1 }, (_, i) =>
      section(`sec-${String(i + 1)}`, [added(`New ${String(i)}`)]),
    );
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(tree, provider),
    );
    expect(run.answer.text).toContain(
      '1 more section also changes and is not covered here.',
    );
  });

  it('truncates one huge run so it cannot crowd out other sections', async () => {
    const provider = new ScriptedProvider({ reply: 'x [S:sec-1].' });
    const tree = [
      section('sec-1', [struck('w'.repeat(MAX_CHANGE_EXCERPT_CHARS * 3))]),
    ];
    const run = await runChip(
      getChip('what-changes'),
      DOC,
      makeDeps(tree, provider),
    );
    expect(run.hits[0]?.chunk.text).toHaveLength(MAX_CHANGE_EXCERPT_CHARS + 1);
    expect(run.hits[0]?.chunk.text.endsWith('…')).toBe(true);
  });

  it('declines without a model call or retrieval when nothing is marked up', async () => {
    const provider = new ScriptedProvider();
    const deps = makeDeps([section('sec-1', [same('Plain.')])], provider);
    const run = await runChip(getChip('what-changes'), DOC, deps);
    expect(run.answer.declined).toBe(true);
    expect(provider.calls).toHaveLength(0);
    expect(run.backendUsage.embedTokens).toBe(0);
    expect(run.answer.text).not.toContain('more section');
  });
});
