import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import { getChip, runChip } from './chips.js';
import { promptVersion } from './answer/prompt.js';
import {
  MAP_UNITS_PER_CALL,
  MAP_INSTRUCTION,
  MAX_MAP_UNITS,
  MIN_MAP_UNITS,
  OUTLINE_CHAR_BUDGET,
  REDUCE_INSTRUCTION,
  SUMMARY_PROMPT_VERSION,
  buildOutline,
  chooseMapUnits,
} from './chip-summary.js';
import type { ChipDeps } from './chip-types.js';
import {
  EMPTY_METADATA,
  makeChunkId,
  walkSections,
  type Chunk,
  type LlmProvider,
  type LlmStreamEvent,
  type Section,
  type TextRequest,
} from './model/index.js';

const DOC = 'd'.repeat(64);

it('derives the summary cache version from the question, single-call, map and reduce prompts', () => {
  const chip = getChip('summary');
  expect(SUMMARY_PROMPT_VERSION).toBe(
    promptVersion(
      chip.label,
      chip.answerInstruction!,
      MAP_INSTRUCTION,
      REDUCE_INSTRUCTION,
    ),
  );
});

const sec = (
  id: string,
  over: Partial<Section> & { text?: string } = {},
): Section => {
  const { text, ...rest } = over;
  return {
    id,
    level: id.split('/').length,
    spans: text ? [{ text, status: 'unchanged' }] : [],
    children: [],
    ...rest,
  };
};

/** NDAA-shaped: divisions > titles > sections, containers have no text of their own. */
function ndaaShaped(divisions: number, titles: number, sections: number) {
  const tree: Section[] = [];
  for (let d = 0; d < divisions; d++) {
    const dId = `division-${String.fromCharCode(65 + d)}`;
    const dChildren: Section[] = [];
    for (let t = 0; t < titles; t++) {
      const tId = `${dId}/title-${String(t + 1)}`;
      const tChildren = Array.from({ length: sections }, (_, s) => {
        const id = `${tId}/sec-${String(d)}${String(t)}${String(s)}`;
        return sec(id, {
          num: `${String(d)}${String(t)}${String(s)}`,
          heading: `Rule ${String(d)}.${String(t)}.${String(s)}`,
          text: `Text of ${id}.`,
        });
      });
      dChildren.push(
        sec(tId, {
          num: `Title ${String(t + 1)}`,
          heading: `Title ${String(t + 1)} of ${dId}`,
          children: tChildren,
        }),
      );
    }
    tree.push(
      sec(dId, {
        num: `Division ${dId.slice(-1)}`,
        heading: `Division ${dId.slice(-1)} matters`,
        children: dChildren,
      }),
    );
  }
  return tree;
}

/** One chunk per section that has text, with the deterministic `:0` id. */
function chunksFor(sections: readonly Section[]): Chunk[] {
  return [...walkSections(sections)]
    .filter((s) => s.spans.length > 0)
    .map((s) => {
      const text = s.spans.map((x) => x.text).join('');
      return {
        id: makeChunkId(DOC, s.id, 0),
        docId: DOC,
        sectionId: s.id,
        breadcrumb: `Sec. ${s.id}`,
        chunkType: 'operative' as const,
        amendmentStatus: 'unchanged' as const,
        text,
        embedText: text,
        definedTermsUsed: [],
        refs: [],
        tokenCount: 5,
        pageStart: 1,
        lineStart: 1,
        lineEnd: 2,
      };
    });
}

let backend: MemoryBackend;
let deps: ChipDeps;
const userOf = (req: TextRequest): string => req.messages[0]!.content;
const isReduce = (req: TextRequest): boolean =>
  userOf(req).includes('partial summary') ||
  userOf(req).includes('Partial summary');
/** Section of the second excerpt: a unit's opening text (the first excerpt is its outline). */
const openingSection = (req: TextRequest): string =>
  [...userOf(req).matchAll(/section="([^"]+)"/g)][1]![1]!;

async function setup(sections: Section[], provider: LlmProvider) {
  backend = new MemoryBackend();
  await backend.upsertChunks(DOC, chunksFor(sections));
  deps = {
    backend,
    provider,
    doc: { metadata: EMPTY_METADATA, sections },
  };
}

describe('chooseMapUnits', () => {
  it('descends divisions to titles until there are enough units', () => {
    const { units, omitted } = chooseMapUnits(ndaaShaped(7, 3, 4));
    expect(units).toHaveLength(21);
    expect(units.every((u) => u.id.includes('/title-'))).toBe(true);
    expect(omitted).toBe(0);
  });

  it('keeps the top level when it already has enough units', () => {
    const { units } = chooseMapUnits(ndaaShaped(MIN_MAP_UNITS, 2, 2));
    expect(units).toHaveLength(MIN_MAP_UNITS);
    expect(units[0]?.id).toBe('division-A');
  });

  it('does not descend into real sections that merely have subsections', () => {
    const tree = [
      sec('sec-1', { children: [sec('sec-1/a', { text: 'a' })] }),
      sec('sec-2', { children: [sec('sec-2/a', { text: 'a' })] }),
    ];
    expect(chooseMapUnits(tree).units.map((u) => u.id)).toEqual([
      'sec-1',
      'sec-2',
    ]);
  });

  it('refuses a descent that would exceed the cap', () => {
    // 5 divisions x 20 titles = 100 > MAX_MAP_UNITS, so stay at divisions.
    const { units } = chooseMapUnits(ndaaShaped(5, 20, 1));
    expect(units).toHaveLength(5);
  });

  it('caps flat bills and reports the rest as omitted', () => {
    const flat = Array.from({ length: MAX_MAP_UNITS + 15 }, (_, i) =>
      sec(`sec-${String(i)}`, { text: 't' }),
    );
    const { units, omitted } = chooseMapUnits(flat);
    expect(units).toHaveLength(MAX_MAP_UNITS);
    expect(omitted).toBe(15);
  });
});

describe('buildOutline', () => {
  it('lists "num heading" lines, indented by depth', () => {
    const [division] = ndaaShaped(1, 2, 1);
    const { text, listed } = buildOutline(division!);
    expect(text.split('\n').slice(0, 2)).toEqual([
      'Division A Division A matters',
      '  Title 1 Title 1 of division-A',
    ]);
    expect(text).toContain('    000 Rule 0.0.0');
    expect(listed).toContain('division-A/title-2/sec-010');
  });

  it('falls back to the id when a section has no number or heading', () => {
    expect(buildOutline(sec('odd-1')).text).toBe('odd-1');
  });

  it('lists whole levels that fit, then fills the next level in document order under the right parents', () => {
    const [division] = ndaaShaped(1, 3, 400);
    const { text, listed } = buildOutline(division!);
    const lines = text.split('\n');
    // The "N more" trailer is not counted against the budget.
    expect(text.length).toBeLessThanOrEqual(OUTLINE_CHAR_BUDGET + 40);
    // The budget is spent: well over division + titles, but not all 1200 sections.
    expect(listed.length).toBeGreaterThan(50);
    expect(listed.length).toBeLessThan(1200);
    expect(text.length).toBeGreaterThan(OUTLINE_CHAR_BUDGET - 100);
    // Depth-first: the first title is followed by its own sections, then comes title 2.
    const titleLines = lines
      .map((l, i) => [l, i] as const)
      .filter(([l]) => /^ {2}Title \d/.test(l));
    expect(titleLines).toHaveLength(3);
    const [t1, t2] = titleLines;
    expect(lines[t1![1] + 1]).toMatch(/^ {4}0\d+ Rule 0\.0\.0/);
    expect(t2![1]).toBeGreaterThan(t1![1] + 1);
    // Sections between title 1 and title 2 all belong to title 1.
    for (const l of lines.slice(t1![1] + 1, t2![1])) {
      expect(l).toMatch(/Rule 0\.0\./);
    }
    expect(text).toMatch(
      new RegExp(
        `\\(${String(1204 - listed.length)} more sections not listed\\)$`,
      ),
    );
  });

  it('prints the full tree depth-first when everything fits', () => {
    const [division] = ndaaShaped(1, 2, 2);
    expect(buildOutline(division!).text.split('\n')).toEqual([
      'Division A Division A matters',
      '  Title 1 Title 1 of division-A',
      '    000 Rule 0.0.0',
      '    001 Rule 0.0.1',
      '  Title 2 Title 2 of division-A',
      '    010 Rule 0.1.0',
      '    011 Rule 0.1.1',
    ]);
  });

  it('counts a single leftover as singular', () => {
    const wide = sec('a', {
      children: [sec('a/b', { heading: 'x'.repeat(OUTLINE_CHAR_BUDGET) })],
    });
    expect(buildOutline(wide).text).toContain('(1 more section not listed)');
  });
});

describe('summary chip', () => {
  let provider: ScriptedProvider;
  beforeEach(() => {
    provider = new ScriptedProvider({ reply: 'Summary [S:division-A].' });
  });

  it('short bill: one call; each part gets an outline excerpt and its first chunk', async () => {
    const tree = [
      sec('sec-1', {
        num: '1',
        heading: 'Short title',
        text: 'The Clean Act.',
      }),
      sec('sec-2', { num: '2', heading: 'Grants', text: 'Grants are made.' }),
    ];
    await setup(tree, provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(provider.calls).toHaveLength(1);
    const user = userOf(provider.calls[0] as TextRequest);
    expect(user).toContain('1 Short title');
    expect(user).toContain('The Clean Act.');
    // Outline excerpts are built for the prompt; only stored chunks are returned.
    expect(run.hits).toHaveLength(2);
    expect(run.mode).toBe('none');
    expect(run.hits.every((h) => !h.chunk.id.includes(':~'))).toBe(true);
    expect(user).toContain('Summarize the whole bill');
  });

  it('uses the structural outline on an NDAA-shaped bill: map per batch of titles, then reduce', async () => {
    const tree = ndaaShaped(7, 3, 4); // 21 title units
    provider = new ScriptedProvider({
      reply: (req) =>
        isReduce(req)
          ? 'Combined [S:division-A/title-1/sec-000].'
          : `Part [S:${openingSection(req)}].`,
    });
    await setup(tree, provider);
    const run = await runChip(getChip('summary'), DOC, deps);

    expect(provider.calls).toHaveLength(Math.ceil(21 / MAP_UNITS_PER_CALL) + 1);
    const first = userOf(provider.calls[0] as TextRequest);
    // Outline lines for sections below the first section of the division are visible.
    expect(first).toContain('Rule 0.0.3');
    expect(first).toContain('Title 1 of division-A');
    expect(first.match(/<excerpt /g)).toHaveLength(MAP_UNITS_PER_CALL * 2);
    expect(run.answer.text).toContain('Combined');
    expect(run.answer.invalidCitations).toEqual([]);
    // Real chunk, never a synthetic one, behind the citation.
    const citation = run.answer.citations.find(
      (c) => c.sectionId === 'division-A/title-1/sec-000',
    );
    expect(citation?.valid).toBe(true);
    expect(citation?.chunkIds).toEqual([
      makeChunkId(DOC, 'division-A/title-1/sec-000', 0),
    ]);
    expect(run.answer.usage.outputTokens).toBeGreaterThan(3);
  });

  it('a citation to a section listed only in an outline is valid but has no stored chunk', async () => {
    const tree = ndaaShaped(1, 1, 1);
    provider = new ScriptedProvider({
      reply: 'Covers a rule [S:division-A/title-1/sec-000].',
    });
    await setup(tree, provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.invalidCitations).toEqual([]);
    expect(
      run.answer.citations.every((c) =>
        c.chunkIds.every((id) => !id.includes(':~')),
      ),
    ).toBe(true);
  });

  it('reduce cannot cite a stand-in or ordinal (sec-12 -> sec-1 regression)', async () => {
    const flat = Array.from({ length: 30 }, (_, i) =>
      sec(`sec-${String(i + 1)}`, {
        text: `Agency ${String(i + 1)} duties.`,
      }),
    );
    // Follows system rule 2 literally: cites the excerpt's `section` attribute, then an ordinal.
    provider = new ScriptedProvider({
      reply: (req) =>
        isReduce(req)
          ? 'Agency sec-12 files a report [S:summary-part-1]. Another claim [S:1].'
          : `Part [S:${openingSection(req)}].`,
    });
    await setup(flat, provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.text).toBe(
      'Agency sec-12 files a report. Another claim.',
    );
    // The ordinal [S:1] resolves to the same stand-in section, so both are one invalid id.
    expect(run.answer.invalidCitations).toEqual(['summary-part-1']);
    expect(run.answer.citations.some((c) => c.valid)).toBe(false);
    expect(run.answer.warnings).toEqual(
      expect.arrayContaining([
        'INVALID_CITATIONS_REMOVED',
        'NO_VALID_CITATIONS',
      ]),
    );
  });

  it('reduce keeps markers copied from the partial summary, with the real section location', async () => {
    const flat = Array.from({ length: 30 }, (_, i) =>
      sec(`sec-${String(i + 1)}`, { text: `Agency ${String(i + 1)} duties.` }),
    );
    provider = new ScriptedProvider({
      reply: (req) =>
        isReduce(req)
          ? 'Agency 12 files a report [S:sec-12].'
          : `Part [S:${openingSection(req)}] [S:sec-${userOf(req).includes('sec-12') ? '12' : '1'}].`,
    });
    await setup(flat, provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    const c = run.answer.citations.find((x) => x.sectionId === 'sec-12');
    expect(c?.valid).toBe(true);
    expect(c?.chunkIds).toEqual([makeChunkId(DOC, 'sec-12', 0)]);
    expect(c?.location).toEqual({
      pageStart: 1,
      pageEnd: 1,
      lineStart: 1,
      lineEnd: 2,
    });
  });

  it('says how many parts beyond the cap are not covered', async () => {
    const flat = Array.from({ length: MAX_MAP_UNITS + 5 }, (_, i) =>
      sec(`sec-${String(i)}`, { text: `Text ${String(i)}.` }),
    );
    provider = new ScriptedProvider({
      reply: (req) =>
        isReduce(req) ? 'Done [S:sec-0].' : `Part [S:${openingSection(req)}].`,
    });
    await setup(flat, provider);
    const tokens: string[] = [];
    const run = await runChip(getChip('summary'), DOC, deps, {
      onToken: (t) => tokens.push(t),
    });
    expect(provider.calls).toHaveLength(MAX_MAP_UNITS / MAP_UNITS_PER_CALL + 1);
    expect(run.answer.text).toMatch(
      /\n\nThis summary covers the first 60 parts of the bill\. 5 more parts are not included\.$/,
    );
    expect(tokens.join('')).toContain('5 more parts are not included');
    expect(run.hits).toHaveLength(MAX_MAP_UNITS);
  });

  it('uses the singular for one uncovered part', async () => {
    const flat = Array.from({ length: MAX_MAP_UNITS + 1 }, (_, i) =>
      sec(`sec-${String(i)}`, { text: `Text ${String(i)}.` }),
    );
    provider = new ScriptedProvider({
      reply: (req) =>
        isReduce(req) ? 'Done [S:sec-0].' : `Part [S:${openingSection(req)}].`,
    });
    await setup(flat, provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.text).toContain('1 more part is not included.');
  });

  it('carries TRUNCATED from a map step into the final result', async () => {
    const flat = Array.from({ length: 15 }, (_, i) =>
      sec(`sec-${String(i)}`, { text: `Text ${String(i)}.` }),
    );
    let calls = 0;
    const truncating: LlmProvider = {
      id: 'mock',
      model: 'scripted',
      generateObject: () => Promise.reject(new Error('unused')),
      async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
        const mine = ++calls;
        const reduce = isReduce(req);
        yield {
          type: 'text',
          text: reduce ? 'Done [S:sec-0].' : `Part [S:${openingSection(req)}].`,
        };
        yield {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
          // Only the first map call is cut off.
          stopReason: mine === 1 ? 'max_tokens' : 'end_turn',
        };
        await Promise.resolve();
      },
    };
    await setup(flat, truncating);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.warnings).toContain('TRUNCATED');
  });

  it('does not duplicate TRUNCATED when the reduce step is itself truncated', async () => {
    const flat = Array.from({ length: 15 }, (_, i) =>
      sec(`sec-${String(i)}`, { text: `Text ${String(i)}.` }),
    );
    const truncating: LlmProvider = {
      id: 'mock',
      model: 'scripted',
      generateObject: () => Promise.reject(new Error('unused')),
      async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
        yield {
          type: 'text',
          text: isReduce(req)
            ? 'Done [S:sec-0].'
            : `Part [S:${openingSection(req)}].`,
        };
        yield {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'max_tokens',
        };
        await Promise.resolve();
      },
    };
    await setup(flat, truncating);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.warnings.filter((w) => w === 'TRUNCATED')).toHaveLength(
      1,
    );
  });

  it('falls back to a descendant chunk when a unit has no text of its own', async () => {
    const tree = [
      sec('part-1', { children: [sec('part-1/a', { text: 'Deep text.' })] }),
    ];
    // "part-1" is a container, so its child becomes the unit only after descent; with one
    // unit there is no descent need, and the fallback finds the child's chunk.
    await setup(tree, provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(userOfLast(provider)).toContain('Deep text.');
    expect(run.hits.some((h) => h.chunk.sectionId === 'part-1/a')).toBe(true);
  });

  it('declines without a model call when the document has no sections', async () => {
    await setup([], provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.declined).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it('declines in the reduce step when every map step declined', async () => {
    const flat = Array.from({ length: 15 }, (_, i) =>
      sec(`sec-${String(i)}`, { text: `Text ${String(i)}.` }),
    );
    provider = new ScriptedProvider({
      reply: "This document doesn't address that question.",
    });
    await setup(flat, provider);
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.declined).toBe(true);
    expect(provider.calls).toHaveLength(2);
  });
});

function userOfLast(p: ScriptedProvider): string {
  return userOf(p.calls.at(-1) as TextRequest);
}
