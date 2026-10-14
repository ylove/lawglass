import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import { CHIPS, getChip, runChip } from './chips.js';
import { MAX_LISTED_DEFINITIONS, interleave } from './chip-runner.js';
import type { ChipDeps } from './chip-types.js';
import {
  BillMetadata,
  ChipDefinition,
  ChipId,
  type Definition,
  EMPTY_METADATA,
  makeChunkId,
  type Chunk,
  type Section,
} from './model/index.js';
import { MAX_INJECTED_DEFINITIONS } from './retrieve/index.js';

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
      'Sponsored by Rep. Ada Lovelace, Sen. Grace Hopper. Cosponsors, if any, are not included.',
    );
    expect(run.answer.declined).toBe(false);
    expect(run.answer.provider).toBe('none');
    expect(run.hits).toEqual([]);
    expect(run.mode).toBe('none');
    expect(provider.calls).toHaveLength(0);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('streams its text so the CLI and UI show it', async () => {
    const tokens: string[] = [];
    const run = await runChip(getChip('sponsors'), DOC, deps, {
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join('')).toBe(run.answer.text);
    const none = { ...SPONSORS, sponsors: null };
    deps.doc.metadata = none;
    tokens.length = 0;
    await runChip(getChip('sponsors'), DOC, deps, {
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join('')).toBe("This document doesn't say who sponsored it.");
  });

  it('uses the singular for one sponsor', async () => {
    deps.doc.metadata = { ...SPONSORS, sponsors: ['Rep. Ada Lovelace'] };
    const run = await runChip(getChip('sponsors'), DOC, deps);
    expect(run.answer.text).toBe(
      'Sponsored by Rep. Ada Lovelace. Cosponsors, if any, are not included.',
    );
  });

  it.each([null, [], ['  ']])('says so when sponsors are %j', async (value) => {
    deps.doc.metadata = { ...SPONSORS, sponsors: value };
    const run = await runChip(getChip('sponsors'), DOC, deps);
    expect(run.answer.text).toBe("This document doesn't say who sponsored it.");
    expect(provider.calls).toHaveLength(0);
  });
});

describe('runChip: retrieve chips', () => {
  it('who-affected uses hybrid_rerank and reranks', async () => {
    const rerank = vi.spyOn(backend, 'rerank');
    await runChip(getChip('who-affected'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({ mode: 'hybrid_rerank' });
    expect(rerank).toHaveBeenCalled();
  });

  it('penalties is sparse-weighted 0.75 with no chunk-type filter, current law only, one final rerank', async () => {
    const search = vi.spyOn(backend, 'search');
    const rerank = vi.spyOn(backend, 'rerank');
    const run = await runChip(getChip('penalties'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({
      mode: 'hybrid',
      sparseWeight: 0.75,
      injectDefinitions: false,
    });
    expect(optionsOf(0).filter).toBeUndefined();
    // Both queries ran; the merged candidates are reranked once against the chip's question.
    expect(retrieveSpy).toHaveBeenCalledTimes(2);
    expect(rerank).toHaveBeenCalledTimes(1);
    expect(rerank.mock.calls[0]![0].query).toBe('Penalties and enforcement');
    const filters = search.mock.calls.map(([r]) => r.filter);
    expect(
      filters.every((f) => f?.amendmentStatus?.includes('deleted') === false),
    ).toBe(true);
    expect(run.hits.some((h) => h.chunk.sectionId === 'sec-4')).toBe(true);
    expect(run.hits.every((h) => h.chunk.amendmentStatus !== 'deleted')).toBe(
      true,
    );
  });

  it('effective-date is sparse-heavy (0.85) with no chunk-type filter and a single query, so no extra rerank', async () => {
    const rerank = vi.spyOn(backend, 'rerank');
    const run = await runChip(getChip('effective-date'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({ mode: 'hybrid', sparseWeight: 0.85 });
    expect(optionsOf(0).filter).toBeUndefined();
    expect(run.hits[0]?.chunk.sectionId).toBe('sec-5');
    expect(rerank).not.toHaveBeenCalled();
    expect(run.answer.text).toContain('[S:sec-3]');
  });

  it('money filters to appropriation/operative/findings chunks and reranks once', async () => {
    const rerank = vi.spyOn(backend, 'rerank');
    const run = await runChip(getChip('money'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({
      filter: { chunkType: ['appropriation', 'operative', 'findings'] },
    });
    expect(rerank).toHaveBeenCalledTimes(1);
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

describe('ChipRun.mode', () => {
  it.each([
    ['who-affected', 'hybrid_rerank'],
    ['penalties', 'hybrid'],
    ['effective-date', 'hybrid'],
    ['money', 'hybrid'],
    ['definitions', 'dense'],
    ['summary', 'none'],
    ['what-changes', 'none'],
    ['sponsors', 'none'],
  ] as const)('%s reports %s', async (id, mode) => {
    const run = await runChip(getChip(id), DOC, deps);
    expect(run.mode).toBe(mode);
  });
});

describe('definitions injected once per run', () => {
  it('retrieves without injection, then injects at most MAX_INJECTED_DEFINITIONS for the final list', async () => {
    const terms = Array.from({ length: 9 }, (_, i) => `term${String(i)}`);
    await backend.upsertChunks(DOC, [
      ...terms.map((t, i) =>
        chunk(`def-${String(i)}`, 0, {
          text: `The term "${t}" means something about fines and money.`,
          chunkType: 'definition',
          definesTerm: t,
        }),
      ),
      chunk('use', 0, {
        text: 'A fine or money penalty uses every term.',
        definedTermsUsed: terms,
      }),
    ]);
    const search = vi.spyOn(backend, 'search');
    const run = await runChip(getChip('penalties'), DOC, deps);
    for (let i = 0; i < retrieveSpy.mock.calls.length; i++) {
      expect(optionsOf(i).injectDefinitions).toBe(false);
    }
    const lookups = search.mock.calls.filter(([r]) => r.filter?.definesTerm);
    expect(lookups.length).toBeLessThanOrEqual(MAX_INJECTED_DEFINITIONS);
    const injected = run.hits.filter((h) => h.chunk.chunkType === 'definition');
    expect(injected.length).toBeLessThanOrEqual(MAX_INJECTED_DEFINITIONS + 1);
  });
});

describe('runChip: definitions', () => {
  const defChunks = (n: number): Chunk[] =>
    Array.from({ length: n }, (_, i) =>
      chunk(`d-${String(i).padStart(3, '0')}`, 0, {
        text: `The term "t${String(i)}" means thing ${String(i)}.`,
        chunkType: 'definition',
        definesTerm: `t${String(i)}`,
      }),
    );

  it('fetches definition chunks (no injection) and lists them', async () => {
    const run = await runChip(getChip('definitions'), DOC, deps);
    expect(optionsOf(0)).toMatchObject({
      mode: 'dense',
      topK: 1000,
      injectDefinitions: false,
      filter: { chunkType: ['definition'] },
    });
    expect(run.hits.map((h) => h.chunk.sectionId)).toEqual(['sec-2']);
    expect(promptOf()).toContain('List the defined terms');
    expect(run.answer.text).not.toContain('more defined');
  });

  it('caps the list, keeps document order, and says how many more exist', async () => {
    const extra = MAX_LISTED_DEFINITIONS + 7;
    await backend.upsertChunks(DOC, defChunks(extra));
    // Document order is reverse of id order, so a sort by id would fail this test.
    deps.doc.sections = [
      ...Array.from({ length: extra }, (_, i) =>
        section(`d-${String(extra - 1 - i).padStart(3, '0')}`),
      ),
    ];
    const run = await runChip(getChip('definitions'), DOC, deps);
    expect(run.hits).toHaveLength(MAX_LISTED_DEFINITIONS);
    expect(run.hits[0]?.chunk.sectionId).toBe(
      `d-${String(extra - 1).padStart(3, '0')}`,
    );
    // 32 new definitions + the one in sec-2 = 33 total, 25 shown.
    expect(run.answer.text).toMatch(
      /\n\n8 more defined terms are in the bill but not listed here\.$/,
    );
  });

  it('puts document-wide definitions before section-limited ones', async () => {
    await backend.upsertChunks(DOC, defChunks(3));
    const defs: Definition[] = [
      {
        term: 't0',
        text: 'x',
        sectionId: 'd-000',
        scope: 'section',
        scopeSectionId: 'd-000',
      },
      { term: 't1', text: 'x', sectionId: 'd-001', scope: 'unknown' },
      { term: 't2', text: 'x', sectionId: 'd-002', scope: 'document' },
    ];
    deps.doc.definitions = defs;
    deps.doc.sections = ['d-000', 'd-001', 'd-002', 'sec-2'].map((id) =>
      section(id),
    );
    const run = await runChip(getChip('definitions'), DOC, deps);
    expect(run.hits.map((h) => h.chunk.definesTerm)).toEqual([
      't2',
      't1',
      'eligible town',
      't0',
    ]);
  });
});

describe('interleave', () => {
  const h = (id: string) => ({
    chunk: { id } as Parameters<typeof interleave>[0][0][0]['chunk'],
    score: 1,
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
