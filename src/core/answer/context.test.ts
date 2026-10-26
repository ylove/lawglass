import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { envVar } from '../brand.js';
import {
  EMPTY_METADATA,
  makeChunkId,
  type Chunk,
  type Section,
} from '../model/index.js';
import { chunkDocument } from '../chunk/index.js';
import {
  contextMode,
  documentContext,
  documentHits,
  estimatedTokens,
  deleteIndexedDocument,
  forgetDocument,
  MEMO_OWNER,
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
  it('leaves room for reference text beside the bill', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const sections = [section('sec-1')];
    const mode = async (reservedTokens: number) =>
      (
        await documentContext(backend, DOC, sections, {
          budget: 15,
          reservedTokens,
        })
      ).mode;
    expect(await mode(0)).toBe('whole');
    expect(await mode(5)).toBe('whole');
    expect(await mode(6)).toBe('excerpts');
    expect(await mode(99)).toBe('excerpts');
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

  it('memoizes the scan per document and backend, evicts on removal and is bounded', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const get = vi.spyOn(backend, 'getChunks');
    const sections = [section('sec-1')];
    const first = await documentContext(backend, DOC, sections, { budget: 50 });
    const calls = get.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    // Different budgets and the deleted-text view reuse the same scan.
    await documentContext(backend, DOC, sections, { budget: 5 });
    await documentContext(backend, DOC, sections, {
      budget: 50,
      includeDeleted: true,
    });
    expect(get.mock.calls.length).toBe(calls);
    // A wrapper that names the real backend as its owner shares the memo.
    const wrapper = Object.assign(Object.create(backend) as MemoryBackend, {
      [MEMO_OWNER]: backend,
    });
    expect(
      (await documentContext(wrapper, DOC, sections, { budget: 50 })).hits,
    ).toEqual(first.hits);
    expect(get.mock.calls.length).toBe(calls);
    // Another store never sees this memo.
    const other = new MemoryBackend();
    await other.upsertChunks(DOC, [chunk('sec-1', 0), chunk('sec-1', 1)]);
    expect(
      (await documentContext(other, DOC, sections, { budget: 50 })).hits,
    ).toHaveLength(2);
    forgetDocument(backend, DOC);
    await documentContext(backend, DOC, sections, { budget: 50 });
    expect(get.mock.calls.length).toBeGreaterThan(calls);
    // Past the document cap, the least recently used scan is dropped.
    const many = Array.from(
      { length: 20 },
      (_, n) => 'f'.repeat(63) + n.toString(16).padStart(1, '0'),
    );
    for (const id of many) {
      await backend.upsertChunks(id, [
        { ...chunk('sec-1', 0), docId: id, id: makeChunkId(id, 'sec-1', 0) },
      ]);
      await documentContext(backend, id, sections, { budget: 50 });
    }
    get.mockClear();
    await documentContext(backend, many[0]!, sections, { budget: 50 });
    expect(get).toHaveBeenCalled();
    get.mockClear();
    await documentContext(backend, many[19]!, sections, { budget: 50 });
    expect(get).not.toHaveBeenCalled();
  });

  it('does not memoize a failed scan', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const sections = [section('sec-1')];
    const get = vi
      .spyOn(backend, 'getChunks')
      .mockRejectedValueOnce(new Error('transient'));
    await expect(
      documentContext(backend, DOC, sections, { budget: 50 }),
    ).rejects.toThrow('transient');
    expect(
      (await documentContext(backend, DOC, sections, { budget: 50 })).hits,
    ).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reads a bill of small sections in one round trip', async () => {
    const backend = new MemoryBackend();
    const sections = Array.from({ length: 300 }, (_, n) => ({
      ...section(`sec-${String(n)}`),
      spans: [
        { text: 'Short rule. '.repeat(10), status: 'unchanged' as const },
      ],
    }));
    await backend.upsertChunks(
      DOC,
      sections.flatMap((s) => [chunk(s.id, 0), chunk(s.id, 1)]),
    );
    const get = vi.spyOn(backend, 'getChunks');
    const hits = await documentHits(backend, DOC, sections);
    expect(hits).toHaveLength(600);
    // 300 sections x 6 probes = 1,800 ids = four 500-id batches issued together, one round.
    expect(get.mock.calls.length).toBeLessThanOrEqual(4);
    const sizes = get.mock.calls.reduce((n, [, ids]) => n + ids.length, 0);
    expect(sizes).toBeLessThanOrEqual(300 * 8);
  });

  async function scanChunked(text: string) {
    const backend = new MemoryBackend();
    const sections: Section[] = [
      { ...section('sec-1'), spans: [{ text, status: 'unchanged' }] },
    ];
    const chunks = chunkDocument({
      docId: DOC,
      sourceUrl: 'https://example.gov/bill.xml',
      format: 'xml',
      fetchedAt: '2026-10-26T00:00:00.000Z',
      metadata: { ...EMPTY_METADATA },
      sections,
      definitions: [],
      externalRefs: [],
      warnings: [],
    });
    await backend.upsertChunks(DOC, chunks);
    const { hits } = await documentContext(backend, DOC, sections, {
      budget: 1_000_000,
    });
    return { chunks, hits };
  }
  const squash = (text: string): string => text.split(/\s+/).join(' ').trim();

  it('trims exactly the overlap the chunker adds: unique text joins back to the source', async () => {
    const text = Array.from(
      { length: 1500 },
      (_, n) => `word${String(n)}`,
    ).join(' ');
    const { chunks, hits } = await scanChunked(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(hits.map((h) => h.chunk.id)).toEqual(chunks.map((c) => c.id));
    expect(squash(hits.map((h) => h.chunk.text).join(' '))).toBe(text);
    const raw = chunks.reduce((n, c) => n + c.tokenCount, 0);
    expect(hits.reduce((n, h) => n + h.chunk.tokenCount, 0)).toBeLessThan(raw);
  });

  it('never drops real text when the wording repeats', async () => {
    const fees = 'The fee is $0. '.repeat(600).trim();
    const zeros = `FY350 ${'0 '.repeat(1200)}end`;
    for (const text of [fees, zeros]) {
      const { hits } = await scanChunked(text);
      const joined = squash(hits.map((h) => h.chunk.text).join(' '));
      // Repeated wording may leave a duplicated tail, but never fewer words than the source.
      expect(joined.split(' ').length).toBeGreaterThanOrEqual(
        text.split(/\s+/).length,
      );
      expect(joined.startsWith(text.split(/\s+/).slice(0, 5).join(' '))).toBe(
        true,
      );
    }
  });

  it('does not trim a chunk that only looks like it overlaps', async () => {
    const backend = new MemoryBackend();
    const a = { ...chunk('sec-1', 0), text: 'one two three four five six' };
    const b = { ...chunk('sec-1', 1), text: 'five six seven eight' };
    await backend.upsertChunks(DOC, [a, b]);
    const { hits } = await documentContext(backend, DOC, [section('sec-1')], {
      budget: 1000,
    });
    // The chunker would have started chunk 1 at its full 50-token window, not at "five".
    expect(hits[1]!.chunk.text).toBe(b.text);
  });

  it('does not pin a missing index: it throws, then scans afresh once the document exists', async () => {
    const backend = new MemoryBackend();
    const sections = [section('sec-1')];
    await expect(
      documentContext(backend, DOC, sections, { budget: 50 }),
    ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const again = await documentContext(backend, DOC, sections, { budget: 50 });
    expect(again.mode).toBe('whole');
    expect(again.hits).toHaveLength(1);
  });

  it('never stores or serves as whole an index that lacks a section with text', async () => {
    const backend = new MemoryBackend();
    const sections: Section[] = [
      {
        ...section('sec-1'),
        spans: [{ text: 'Text one.', status: 'unchanged' }],
      },
      {
        ...section('sec-2'),
        spans: [{ text: 'Text two.', status: 'unchanged' }],
      },
    ];
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const get = vi.spyOn(backend, 'getChunks');
    expect(
      await documentContext(backend, DOC, sections, { budget: 50 }),
    ).toEqual({
      mode: 'excerpts',
      hits: [],
    });
    const calls = get.mock.calls.length;
    await backend.upsertChunks(DOC, [chunk('sec-2', 0)]);
    const full = await documentContext(backend, DOC, sections, { budget: 50 });
    expect(get.mock.calls.length).toBeGreaterThan(calls);
    expect(full.hits).toHaveLength(2);
  });

  it('drops a scan that raced a delete or re-index', async () => {
    const backend = new MemoryBackend();
    const sections = [section('sec-1')];
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const original = backend.getChunks.bind(backend);
    const get = vi
      .spyOn(backend, 'getChunks')
      .mockImplementationOnce(async (id, ids) => {
        const found = await original(id, ids);
        // The document is deleted while this scan is in flight.
        await deleteIndexedDocument(backend, DOC);
        return found;
      });
    // The request that ran the raced scan must not treat what it read as the whole bill (#313).
    expect(
      await documentContext(backend, DOC, sections, { budget: 50 }),
    ).toEqual({ mode: 'excerpts', hits: [] });
    await backend.upsertChunks(DOC, [chunk('sec-1', 0), chunk('sec-1', 1)]);
    const calls = get.mock.calls.length;
    const after = await documentContext(backend, DOC, sections, { budget: 50 });
    expect(get.mock.calls.length).toBeGreaterThan(calls);
    expect(after.hits).toHaveLength(2);
  });

  it('a cancelled request stops waiting for a shared scan at once; the scan still finishes for others (#313)', async () => {
    const backend = new MemoryBackend();
    const sections = [section('sec-1')];
    await backend.upsertChunks(DOC, [chunk('sec-1', 0)]);
    const original = backend.getChunks.bind(backend);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(backend, 'getChunks').mockImplementation(async (id, ids) => {
      await gate;
      return original(id, ids);
    });
    const controller = new AbortController();
    const cancelled = documentContext(backend, DOC, sections, {
      budget: 50,
      signal: controller.signal,
    });
    const other = documentContext(backend, DOC, sections, { budget: 50 });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect((await other).mode).toBe('whole');
  });

  it('shares one in-flight scan between concurrent requests and clears it on settle', async () => {
    const backend = new MemoryBackend();
    const sections = Array.from({ length: 300 }, (_, n) =>
      section(`sec-${String(n)}`),
    );
    await backend.upsertChunks(
      DOC,
      sections.map((s) => chunk(s.id, 0)),
    );
    const get = vi.spyOn(backend, 'getChunks');
    await documentContext(backend, DOC, sections, { budget: 50_000 });
    const single = get.mock.calls.length;
    forgetDocument(backend, DOC);
    get.mockClear();
    await Promise.all(
      [1, 2, 3].map(() =>
        documentContext(backend, DOC, sections, { budget: 50_000 }),
      ),
    );
    expect(get.mock.calls.length).toBe(single);
    // A failed shared scan is not kept: the next request tries again.
    forgetDocument(backend, DOC);
    get.mockRejectedValueOnce(new Error('transient'));
    await expect(
      documentContext(backend, DOC, sections, { budget: 50_000 }),
    ).rejects.toThrow('transient');
    expect(
      (await documentContext(backend, DOC, sections, { budget: 50_000 })).hits,
    ).toHaveLength(300);
  });
});
