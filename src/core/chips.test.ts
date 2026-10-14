import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import { CHIPS, getChip, runChip } from './chips.js';
import {
  MAX_MAP_CALLS,
  MAX_SECTIONS_PER_MAP_CALL,
  interleave,
  type ChipDeps,
} from './chip-runner.js';
import {
  BillMetadata,
  ChipDefinition,
  ChipId,
  EMPTY_METADATA,
  makeChunkId,
  type Chunk,
  type Section,
} from './model/index.js';
import type { RetrievedHit } from './retrieve/index.js';

// Spy on `retrieve` while keeping its real behaviour, to assert what each chip passes it.
const retrieveSpy = vi.hoisted(() => vi.fn());
vi.mock('./retrieve/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retrieve/index.js')>();
  retrieveSpy.mockImplementation(actual.retrieve);
  return { ...actual, retrieve: retrieveSpy };
});

const DOC = 'c'.repeat(64);

function chunk(sectionId: string, n: number, over: Partial<Chunk>): Chunk {
  const text = over.text ?? 'Text.';
  return {
    id: makeChunkId(DOC, sectionId, n),
    docId: DOC,
    sectionId,
    breadcrumb: `Sec. ${sectionId}`,
    chunkType: 'operative',
    amendmentStatus: 'unchanged',
    embedText: `Sec. ${sectionId}: ${text}`,
    definedTermsUsed: [],
    refs: [],
    tokenCount: 5,
    ...over,
    text,
  };
}

const CHUNKS: Chunk[] = [
  chunk('sec-1', 0, { text: 'This act is the Clean Water Act.' }),
  chunk('sec-2', 0, {
    text: 'The term "eligible town" means a town with few residents.',
    chunkType: 'definition',
    definesTerm: 'eligible town',
  }),
  chunk('sec-3', 0, {
    text: 'The department shall award grants to each eligible town.',
    definedTermsUsed: ['eligible town'],
  }),
  chunk('sec-4', 0, {
    text: 'A person who violates this act shall pay a fine of $500.',
    chunkType: 'penalty',
  }),
  chunk('sec-5', 0, {
    text: 'This act takes effect on January 1, 2027.',
    chunkType: 'effective_date',
  }),
  chunk('sec-6', 0, {
    text: 'There is appropriated $2,000,000 for grants.',
    chunkType: 'appropriation',
  }),
  chunk('sec-7', 0, {
    text: 'The twenty day waiting period is added.',
    amendmentStatus: 'inserted',
  }),
  chunk('sec-8', 0, {
    text: 'The thirty day waiting period.',
    amendmentStatus: 'deleted',
  }),
];

const section = (id: string, children: Section[] = []): Section => ({
  id,
  level: 1,
  spans: [],
  children,
});

const SPONSORS: BillMetadata = {
  ...EMPTY_METADATA,
  title: 'Clean Water Act',
  sponsors: ['Rep. Ada Lovelace', 'Sen. Grace Hopper'],
  source: 'structured',
};

let backend: MemoryBackend;
let provider: ScriptedProvider;
let deps: ChipDeps;

beforeEach(async () => {
  retrieveSpy.mockClear();
  backend = new MemoryBackend();
  await backend.upsertChunks(DOC, CHUNKS);
  provider = new ScriptedProvider({ reply: 'An answer [S:sec-3].' });
  deps = {
    backend,
    provider,
    doc: {
      metadata: SPONSORS,
      sections: ['sec-1', 'sec-2', 'sec-3'].map((id) => section(id)),
    },
  };
});

const promptOf = (): string =>
  JSON.stringify((provider.calls.at(-1) as { messages: unknown }).messages);
const optionsOf = (call: number): Record<string, unknown> =>
  retrieveSpy.mock.calls[call]![1] as Record<string, unknown>;

describe('chip definitions', () => {
  it('defines exactly the eight spec chips, each valid against the contract', () => {
    expect(CHIPS.map((c) => c.id).sort()).toEqual([...ChipId.options].sort());
    for (const c of CHIPS) {
      expect(ChipDefinition.safeParse(c).success).toBe(true);
      expect(getChip(c.id)).toBe(c);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(CHIPS)).toBe(true);
    for (const c of CHIPS) {
      expect(Object.isFrozen(c)).toBe(true);
      expect(Object.isFrozen(c.queries)).toBe(true);
    }
    expect(() => {
      (
        getChip('penalties').retrieval as { sparseWeight: number }
      ).sparseWeight = 0;
    }).toThrow();
  });

  it('rejects an unknown id', () => {
    expect(() => getChip('nope' as ChipId)).toThrow(/Unknown chip/);
  });

  it('has the strategies from spec 3.3', () => {
    const strategies = Object.fromEntries(CHIPS.map((c) => [c.id, c.strategy]));
    expect(strategies).toEqual({
      summary: 'outline',
      'what-changes': 'retrieve',
      'who-affected': 'retrieve',
      penalties: 'retrieve',
      'effective-date': 'retrieve',
      money: 'retrieve',
      definitions: 'definitions',
      sponsors: 'metadata',
    });
  });

  it('gives every chip that calls the model a plain-language instruction', () => {
    for (const c of CHIPS.filter((c) => c.strategy !== 'metadata')) {
      expect(c.answerInstruction?.length).toBeGreaterThan(20);
    }
  });
});

describe('runChip: sponsors (metadata only)', () => {
  it('formats sponsors without retrieval or an LLM call', async () => {
    const run = await runChip(getChip('sponsors'), DOC, deps);
    expect(run.answer.text).toBe(
      'Sponsors: Rep. Ada Lovelace, Sen. Grace Hopper.',
    );
    expect(run.answer.declined).toBe(false);
    expect(run.answer.provider).toBe('none');
    expect(run.hits).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('uses the singular for one sponsor', async () => {
    deps.doc.metadata = { ...SPONSORS, sponsors: ['Rep. Ada Lovelace'] };
    const run = await runChip(getChip('sponsors'), DOC, deps);
    expect(run.answer.text).toBe('Sponsor: Rep. Ada Lovelace.');
  });

  it.each([null, [], ['  ']])('says so when sponsors are %j', async (value) => {
    deps.doc.metadata = { ...SPONSORS, sponsors: value };
    const run = await runChip(getChip('sponsors'), DOC, deps);
    expect(run.answer.text).toBe("This document doesn't say who sponsored it.");
    expect(provider.calls).toHaveLength(0);
  });
});

describe('runChip: retrieve chips', () => {
  it('what-changes opts in to deleted chunks with an inserted/deleted filter', async () => {
    const run = await runChip(getChip('what-changes'), DOC, deps);
    for (let i = 0; i < retrieveSpy.mock.calls.length; i++) {
      expect(optionsOf(i)).toMatchObject({
        mode: 'hybrid_rerank',
        includeDeleted: true,
        filter: { amendmentStatus: ['inserted', 'deleted'] },
      });
    }
    const ids = run.hits.map((h) => h.chunk.sectionId).sort();
    expect(ids).toEqual(['sec-7', 'sec-8']);
    expect(promptOf()).toContain('Group your answer by section');
    expect(promptOf()).toContain('status=\\"deleted\\"');
  });

  it('who-affected uses hybrid_rerank and reranks', async () => {
    const rerank = vi.spyOn(backend, 'rerank');
    await runChip(getChip('who-affected'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({ mode: 'hybrid_rerank' });
    expect(rerank).toHaveBeenCalled();
  });

  it('penalties is sparse-weighted 0.75 over penalty/operative chunks, current law only', async () => {
    const search = vi.spyOn(backend, 'search');
    const run = await runChip(getChip('penalties'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({
      mode: 'hybrid',
      sparseWeight: 0.75,
      filter: { chunkType: ['penalty', 'operative'] },
    });
    const filters = search.mock.calls.map(([r]) => r.filter);
    expect(
      filters.every((f) => f?.amendmentStatus?.includes('deleted') === false),
    ).toBe(true);
    expect(run.hits.some((h) => h.chunk.sectionId === 'sec-4')).toBe(true);
    expect(run.hits.every((h) => h.chunk.amendmentStatus !== 'deleted')).toBe(
      true,
    );
  });

  it('effective-date is sparse-heavy (0.85) with no chunk-type filter', async () => {
    const run = await runChip(getChip('effective-date'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({ mode: 'hybrid', sparseWeight: 0.85 });
    expect(optionsOf(0).filter).toBeUndefined();
    expect(run.hits[0]?.chunk.sectionId).toBe('sec-5');
    expect(run.answer.text).toContain('[S:sec-3]');
  });

  it('money filters to appropriation/operative chunks', async () => {
    const run = await runChip(getChip('money'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({
      filter: { chunkType: ['appropriation', 'operative'] },
    });
    expect(run.hits.some((h) => h.chunk.sectionId === 'sec-6')).toBe(true);
    expect(run.hits.every((h) => h.chunk.chunkType !== 'penalty')).toBe(true);
  });

  it('passes the chip instruction, label and metadata to the model', async () => {
    await runChip(getChip('money'), DOC, deps);
    const prompt = promptOf();
    expect(prompt).toContain('List the taxes, fees and spending');
    expect(prompt).toContain('Taxes, fees, and spending');
    expect(prompt).toContain('Clean Water Act');
  });

  it('injects definitions of terms the hits use, outside the topK cap', async () => {
    const run = await runChip(getChip('money'), DOC, deps);
    // sec-3 uses "eligible town"; its definition (sec-2) rides along as an injected hit.
    expect(run.hits.some((h) => h.chunk.sectionId === 'sec-2')).toBe(true);
  });

  it('sums backend usage across queries', async () => {
    const run = await runChip(getChip('money'), DOC, deps);
    expect(run.backendUsage.embedTokens).toBeGreaterThan(0);
  });

  it('declines without a model call when nothing matches', async () => {
    const empty = new MemoryBackend();
    const run = await runChip(getChip('penalties'), DOC, {
      ...deps,
      backend: empty,
    });
    expect(run.answer.declined).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it('forwards the abort signal and streams tokens', async () => {
    const tokens: string[] = [];
    await runChip(getChip('money'), DOC, deps, {
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join('')).toBe('An answer [S:sec-3].');
    const controller = new AbortController();
    controller.abort();
    await expect(
      runChip(getChip('money'), DOC, deps, { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe('runChip: definitions', () => {
  it('lists definition chunks and does not inject more definitions', async () => {
    const run = await runChip(getChip('definitions'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({
      mode: 'dense',
      topK: 60,
      injectDefinitions: false,
      filter: { chunkType: ['definition'] },
    });
    expect(run.hits.map((h) => h.chunk.sectionId)).toEqual(['sec-2']);
    expect(promptOf()).toContain('List the defined terms');
  });
});

describe('interleave', () => {
  const h = (id: string): RetrievedHit => ({
    chunk: { id } as RetrievedHit['chunk'],
    score: 1,
    injected: false,
  });
  it('merges by rank and keeps duplicates once', () => {
    const merged = interleave([
      [h('a'), h('b'), h('c')],
      [h('b'), h('d')],
    ]);
    expect(merged.map((x) => x.chunk.id)).toEqual(['a', 'b', 'd', 'c']);
  });
  it('handles no lists', () => {
    expect(interleave([])).toEqual([]);
  });
});

describe('runChip: summary (outline)', () => {
  it('summarizes a short bill in one call from each section opening', async () => {
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(provider.calls).toHaveLength(1);
    expect(run.hits.map((h) => h.chunk.sectionId)).toEqual([
      'sec-1',
      'sec-2',
      'sec-3',
    ]);
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(promptOf()).toContain('Summarize the whole bill');
  });

  it('falls back to a descendant chunk when a top-level section has no text of its own', async () => {
    deps.doc.sections = [section('sec-9', [section('sec-3')])];
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.hits.map((h) => h.chunk.sectionId)).toEqual(['sec-3']);
  });

  it('skips sections whose only chunk is deleted or missing', async () => {
    deps.doc.sections = ['sec-8', 'sec-404', 'sec-1'].map((id) => section(id));
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.hits.map((h) => h.chunk.sectionId)).toEqual(['sec-1']);
  });

  it('declines without a model call when the outline is empty', async () => {
    deps.doc.sections = [];
    const run = await runChip(getChip('summary'), DOC, deps);
    expect(run.answer.declined).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  describe('long bill (map-reduce)', () => {
    const many = (n: number): Chunk[] =>
      Array.from({ length: n }, (_, i) =>
        chunk(`long-${String(i)}`, 0, {
          text: `Part ${String(i)} of the act.`,
        }),
      );
    const withSections = async (n: number): Promise<void> => {
      await backend.upsertChunks(DOC, many(n));
      deps.doc.sections = Array.from({ length: n }, (_, i) =>
        section(`long-${String(i)}`),
      );
    };

    it('maps batches of at most N sections, then reduces', async () => {
      await withSections(MAX_SECTIONS_PER_MAP_CALL + 3);
      provider = new ScriptedProvider({
        reply: (req) =>
          req.messages[0]!.content.includes('partial summary')
            ? 'Combined [S:long-0] [S:long-13].'
            : req.messages[0]!.content.includes('section="long-0"')
              ? 'First part [S:long-0].'
              : 'Second part [S:long-13].',
      });
      deps.provider = provider;
      const run = await runChip(getChip('summary'), DOC, deps);

      expect(provider.calls).toHaveLength(3); // 2 map + 1 reduce
      const [map1, map2] = provider.calls as unknown as {
        messages: { content: string }[];
      }[];
      expect(map1!.messages[0]!.content.match(/<excerpt /g)).toHaveLength(
        MAX_SECTIONS_PER_MAP_CALL,
      );
      expect(map2!.messages[0]!.content.match(/<excerpt /g)).toHaveLength(3);
      expect(run.answer.text).toBe('Combined [S:long-0] [S:long-13].');
      expect(run.answer.invalidCitations).toEqual([]);
      // Citations point at the real chunks, not at the synthetic partial summaries.
      expect(run.answer.citations.map((c) => c.chunkIds)).toEqual([
        [makeChunkId(DOC, 'long-0', 0)],
        [makeChunkId(DOC, 'long-13', 0)],
      ]);
      expect(run.answer.usage.outputTokens).toBeGreaterThan(3);
    });

    it('caps the number of map calls and drops the remaining sections', async () => {
      await withSections(MAX_SECTIONS_PER_MAP_CALL * MAX_MAP_CALLS + 10);
      provider = new ScriptedProvider({ reply: 'Part [S:long-0].' });
      deps.provider = provider;
      const run = await runChip(getChip('summary'), DOC, deps);
      expect(provider.calls).toHaveLength(MAX_MAP_CALLS + 1);
      expect(run.hits).toHaveLength(MAX_SECTIONS_PER_MAP_CALL * MAX_MAP_CALLS);
    });

    it('streams only the reduce step', async () => {
      await withSections(MAX_SECTIONS_PER_MAP_CALL + 1);
      const tokens: string[] = [];
      await runChip(getChip('summary'), DOC, deps, {
        onToken: (t) => tokens.push(t),
      });
      // Map replies cite sec-3, which is not in the long bill, so partials are unusable.
      expect(tokens.join('')).toBe(
        "This document doesn't address that question.",
      );
    });

    it('declines when every map step declined', async () => {
      await withSections(MAX_SECTIONS_PER_MAP_CALL + 1);
      provider = new ScriptedProvider({
        reply: "This document doesn't address that question.",
      });
      deps.provider = provider;
      const run = await runChip(getChip('summary'), DOC, deps);
      expect(run.answer.declined).toBe(true);
      expect(provider.calls).toHaveLength(2); // both map calls; reduce has nothing to read
    });
  });
});
