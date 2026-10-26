import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { envVar } from '../brand.js';
import { makeChunkId, type Chunk, type Section } from '../model/index.js';
import {
  contextMode,
  documentContext,
  documentHits,
  estimatedTokens,
  wholeBillBudget,
  wholeBillEffort,
} from './context.js';

const DOC = 'a'.repeat(64);
const section = (id: string): Section => ({
  id,
  level: 1,
  spans: [],
  children: [],
});
function chunk(sectionId: string, n: number, deleted = false): Chunk {
  return {
    id: makeChunkId(DOC, sectionId, n),
    docId: DOC,
    sectionId,
    breadcrumb: sectionId,
    text: 'Bill text.',
    embedText: 'Bill text.',
    chunkType: 'operative',
    amendmentStatus: deleted ? 'deleted' : 'unchanged',
    definedTermsUsed: [],
    refs: [],
    tokenCount: 10,
  };
}
afterEach(() => vi.unstubAllEnvs());

describe('whole-bill policy', () => {
  it('includes the exact budget, excludes one over, and disables even empty bills with 0', () => {
    expect(contextMode(100_000)).toBe('whole');
    expect(contextMode(100_001)).toBe('excerpts');
    expect(contextMode(0, 0)).toBe('excerpts');
  });
  it('reads the branded budget, accepting zero and defaulting invalid values', () => {
    for (const raw of [
      '-1',
      '1.5',
      'oops',
      'Infinity',
      '',
      '9007199254740992',
    ]) {
      vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), raw);
      expect(wholeBillBudget()).toBe(100_000);
    }
    vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '0');
    expect(wholeBillBudget()).toBe(0);
    vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '42');
    expect(contextMode(42)).toBe('whole');
    expect(contextMode(43)).toBe('excerpts');
  });
  it('defaults effort to medium and accepts only low, medium or high', () => {
    for (const value of ['low', 'medium', 'high'] as const) {
      vi.stubEnv(envVar('EFFORT'), value);
      expect(wholeBillEffort()).toBe(value);
    }
    vi.stubEnv(envVar('EFFORT'), 'max');
    expect(wholeBillEffort()).toBe('medium');
  });
  it('counts only shown chunks and never fetches when disabled', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC, [
      chunk('sec-1', 0),
      chunk('sec-1', 1, true),
    ]);
    const get = vi.spyOn(backend, 'getChunks');
    const sections = [section('sec-1')];
    expect(
      (await documentContext(backend, DOC, sections, { budget: 10 })).mode,
    ).toBe('whole');
    expect(
      (await documentContext(backend, DOC, sections, { budget: 9 })).mode,
    ).toBe('excerpts');
    expect(
      (
        await documentContext(backend, DOC, sections, {
          budget: 10,
          includeDeleted: true,
        })
      ).mode,
    ).toBe('excerpts');
    const changes = await documentContext(backend, DOC, sections, {
      budget: 20,
      includeDeleted: true,
    });
    expect(changes.hits).toHaveLength(2);
    get.mockClear();
    expect(
      await documentContext(backend, DOC, sections, { budget: 0 }),
    ).toEqual({ mode: 'excerpts', hits: [] });
    expect(get).not.toHaveBeenCalled();
  });
  it('skips fetching chunks for a bill far over budget, judged from section text alone', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const get = vi.spyOn(backend, 'getChunks');
    const long: Section = {
      ...section('sec-1'),
      spans: [{ text: 'x'.repeat(4000), status: 'unchanged' }],
    };
    expect(estimatedTokens([long], false)).toBe(1000);
    expect(
      await documentContext(backend, DOC, [long], { budget: 100 }),
    ).toEqual({ mode: 'excerpts', hits: [] });
    expect(get).not.toHaveBeenCalled();
    // Near the budget the exact chunk count decides.
    expect(
      (await documentContext(backend, DOC, [long], { budget: 700 })).mode,
    ).toBe('whole');
    expect(get).toHaveBeenCalled();
  });

  it('counts struck text toward the estimate only when it will be shown', () => {
    const mixed: Section = {
      ...section('sec-1'),
      spans: [
        { text: 'a'.repeat(400), status: 'unchanged' },
        { text: 'b'.repeat(400), status: 'deleted' },
      ],
    };
    expect(estimatedTokens([mixed], false)).toBe(100);
    expect(estimatedTokens([mixed], true)).toBe(200);
  });

  it('fetches all numbered chunks in bounded batches and restores tree and numeric order', async () => {
    const backend = new MemoryBackend();
    const sections = Array.from({ length: 40 }, (_, n) =>
      section(`sec-${String(n)}`),
    );
    sections[0]!.children.push(section('child'));
    const chunks = [
      ...Array.from({ length: 34 }, (_, n) => chunk('sec-0', n)),
      chunk('child', 0),
      ...sections.slice(1).map((s) => chunk(s.id, 0)),
    ];
    await backend.upsertChunks(DOC, chunks);
    const original = backend.getChunks.bind(backend);
    const fetch = vi
      .spyOn(backend, 'getChunks')
      .mockImplementation(async (id, ids) =>
        (await original(id, ids)).reverse(),
      );
    const hits = await documentHits(backend, DOC, sections);
    expect(hits.map((h) => h.chunk.id)).toEqual(chunks.map((c) => c.id));
    expect(fetch.mock.calls.every(([, ids]) => ids.length <= 500)).toBe(true);
    expect(fetch.mock.calls.length).toBeGreaterThan(2);
  });
  it('honors cancellation before fetching', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      documentHits(
        new MemoryBackend(),
        DOC,
        [section('sec-1')],
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
