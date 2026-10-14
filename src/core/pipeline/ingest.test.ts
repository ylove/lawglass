import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { AnswerCache, type AnswerCacheKey } from '../answer-cache.js';
import {
  makeAmendmentHtml,
  makeAmendingBillPdf,
  makeCongressionalBillXml,
  makeFederalStylePdf,
  makeScannedPdf,
  makeSectionedText,
} from '../../../tests/synth/index.js';
import {
  makePipelineEnv,
  stubPdfParser,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import { AppError, type AnswerResult } from '../model/index.js';
import { ingest, type IngestDeps, type IngestProgress } from './ingest.js';

let env: PipelineEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  const { runtime } = env;
  return {
    backend: runtime.backend,
    provider: runtime.extractProvider,
    registry: runtime.registry,
    fetcher: runtime.fetcher,
    now: runtime.now,
    ...overrides,
  };
}

beforeEach(async () => {
  env = await makePipelineEnv();
});

test('backend initialization failure stops before metadata extraction or writes', async () => {
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  vi.spyOn(env.backend, 'ensureReady').mockRejectedValue(
    new AppError('BACKEND_UNAVAILABLE'),
  );
  const exists = vi.spyOn(env.backend, 'hasDocument');
  const extract = vi.spyOn(env.provider, 'generateObject');
  const write = vi.spyOn(env.backend, 'upsertChunks');
  await expect(
    ingest('https://example.gov/s9001.xml', deps()),
  ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  expect(exists).toHaveBeenCalledOnce();
  expect(extract).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(await env.registry.list()).toEqual([]);
});

test('ingests XML, reports every stage and fills structured metadata', async () => {
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  const stages: IngestProgress[] = [];
  const result = await ingest('https://example.gov/s9001.xml', deps(), {
    onProgress: (p) => stages.push(p),
  });
  expect(result.stats.format).toBe('xml');
  expect(result.stats.reused).toBe(false);
  expect(result.stats.sectionCount).toBeGreaterThan(1);
  expect(result.stats.embedTokens).toBeGreaterThan(0);
  expect(
    Object.values(result.stats.chunkCountsByType).reduce((a, b) => a + b, 0),
  ).toBeGreaterThan(0);
  expect(result.stats.chunkCountsByType.definition).toBeGreaterThan(0);
  expect(result.normalized.metadata.billNumber).not.toBeNull();
  expect(result.doc.label).toBe(result.normalized.metadata.billNumber);
  expect(await env.backend.hasDocument(result.doc.docId)).toBe(true);
  expect((await env.registry.list()).map((e) => e.docId)).toEqual([
    result.doc.docId,
  ]);
  const names = stages.map((s) => s.stage);
  expect(names[0]).toBe('fetching');
  expect(names.at(-1)).toBe('done');
  for (const stage of ['parsing', 'enriching', 'chunking', 'embedding'])
    expect(names).toContain(stage);
  const embedding = stages.filter((s) => s.stage === 'embedding').at(-1);
  expect(embedding?.done).toBe(embedding?.total);
  // Index and registry usage agree.
  expect((await env.registry.list())[0]?.usage.embedTokens).toBe(
    result.stats.embedTokens,
  );
});

test('counts deleted and inserted spans in HTML', async () => {
  env.serve(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
  const result = await ingest('https://example.gov/permit.html', deps());
  expect(result.stats.format).toBe('html');
  expect(result.stats.deletedSpanCount).toBe(4);
  expect(result.stats.insertedSpanCount).toBe(3);
  expect(result.stats.chunkCountsByType).toHaveProperty('other');
});

test('ingests plain text', async () => {
  env.serve(
    'https://example.gov/gardens.txt',
    makeSectionedText(),
    'text/plain',
  );
  const result = await ingest('https://example.gov/gardens.txt', deps());
  expect(result.stats.format).toBe('text');
  expect(result.stats.sectionCount).toBeGreaterThan(3);
  // No title in the text, so the default label falls back to the URL's last segment.
  expect(result.doc.label).toBe('gardens.txt');
});

test('ingests a PDF through the injected parser and keeps page and line spans', async () => {
  const pdf = await makeAmendingBillPdf();
  env = await makePipelineEnv({ parsePdf: stubPdfParser(pdf) });
  env.serve('https://example.gov/hb1.pdf', pdf, 'application/pdf');
  const result = await ingest(
    'https://example.gov/hb1.pdf',
    deps({ parsePdf: env.runtime.parsePdf }),
  );
  expect(result.stats.format).toBe('pdf');
  expect(result.stats.deletedSpanCount).toBeGreaterThan(0);
  const cached = await env.registry.getDocument(result.doc.docId);
  expect(cached.format).toBe('pdf');
});

test('re-ingesting the same document spends zero tokens and touches the registry', async () => {
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  const first = await ingest('https://example.gov/s9001.xml', deps());
  const [before] = await env.registry.list();
  const embedReady = vi.spyOn(env.embedder, 'ensureReady');
  const rerankReady = vi.spyOn(env.reranker, 'ensureReady');
  const embedCalls = env.embedder.calls.length;
  const generate = vi.spyOn(env.provider, 'generateObject');
  const upsert = vi.spyOn(env.backend, 'upsertChunks');

  // Same bytes at another URL are the same document.
  env.serve('https://mirror.example.gov/copy.xml', makeCongressionalBillXml());
  const second = await ingest('https://mirror.example.gov/copy.xml', deps());

  expect(embedReady).not.toHaveBeenCalled();
  expect(rerankReady).not.toHaveBeenCalled();
  expect(second.stats.reused).toBe(true);
  expect(second.stats.embedTokens).toBe(0);
  expect(second.usage).toEqual({
    embedTokens: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
  });
  expect(second.doc.docId).toBe(first.doc.docId);
  expect(second.stats.sectionCount).toBe(first.stats.sectionCount);
  expect(second.stats.chunkCountsByType).toEqual(first.stats.chunkCountsByType);
  expect(env.embedder.calls.length).toBe(embedCalls);
  expect(generate).not.toHaveBeenCalled();
  expect(upsert).not.toHaveBeenCalled();
  const [after] = await env.registry.list();
  expect((after?.lastUsedAt ?? '') > (before?.lastUsedAt ?? '')).toBe(true);
  expect(after?.usage).toEqual(before?.usage);
});

test('a registry entry whose index vanished is re-indexed', async () => {
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  const first = await ingest('https://example.gov/s9001.xml', deps());
  await env.backend.deleteDocument(first.doc.docId);
  const again = await ingest('https://example.gov/s9001.xml', deps());
  expect(again.stats.reused).toBe(false);
  expect(await env.backend.hasDocument(first.doc.docId)).toBe(true);
  expect(await env.registry.list()).toHaveLength(1);
});

test('uses the requested label, and default labels never collide', async () => {
  env.serve(
    'https://example.gov/a.txt',
    { bytes: new TextEncoder().encode('Section 1. A\nOne.\n') },
    'text/plain',
  );
  env.serve(
    'https://other.gov/a.txt',
    { bytes: new TextEncoder().encode('Section 1. B\nTwo.\n') },
    'text/plain',
  );
  const named = await ingest('https://example.gov/a.txt', deps(), {
    label: 'my bill',
  });
  expect(named.doc.label).toBe('my bill');
  const second = await ingest('https://other.gov/a.txt', deps());
  expect(second.doc.label).toBe('a.txt');
  env.serve(
    'https://third.gov/a.txt',
    { bytes: new TextEncoder().encode('Section 1. C\nThree.\n') },
    'text/plain',
  );
  const third = await ingest('https://third.gov/a.txt', deps());
  expect(third.doc.label).toMatch(/^a\.txt \([0-9a-f]{6}\)$/);
});

test('an unusable label leaves no half-indexed namespace behind', async () => {
  env.serve(
    'https://example.gov/a.txt',
    { bytes: new TextEncoder().encode('Section 1. A\nOne.\n') },
    'text/plain',
  );
  env.serve(
    'https://other.gov/b.txt',
    { bytes: new TextEncoder().encode('Section 1. B\nTwo.\n') },
    'text/plain',
  );
  await ingest('https://example.gov/a.txt', deps(), { label: 'taken' });
  await expect(
    ingest('https://other.gov/b.txt', deps(), { label: 'taken' }),
  ).rejects.toBeInstanceOf(AppError);
  const entries = await env.registry.list();
  expect(entries).toHaveLength(1);
  for (const entry of entries)
    expect(await env.backend.hasDocument(entry.docId)).toBe(true);
  expect(env.fetches).toContain('https://other.gov/b.txt');
});

test('evicts the least recently used documents beyond the cap, from index, registry and answers', async () => {
  const cache = new AnswerCache({
    dir: join(env.registry.configDir, 'cache', 'answers'),
  });
  const key = (docId: string): AnswerCacheKey => ({
    docId,
    chipId: 'summary',
    provider: 'mock',
    model: 'test',
    promptVersion: '1',
  });
  const answer: AnswerResult = {
    text: 'Grants are funded [S:sec-1].',
    citations: [{ sectionId: 'sec-1', valid: true, chunkIds: [] }],
    invalidCitations: [],
    warnings: [],
    declined: false,
    readingGrade: 5,
    provider: 'mock',
    model: 'test',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const urls = ['one', 'two', 'three'].map(
    (n) => `https://example.gov/${n}.txt`,
  );
  const ids: string[] = [];
  for (const [i, url] of urls.entries()) {
    env.serve(
      url,
      {
        bytes: new TextEncoder().encode(
          `Section 1. T\nDoc number ${String(i)}.\n`,
        ),
      },
      'text/plain',
    );
    const docId = (await ingest(url, deps({ maxDocs: 2 }))).doc.docId;
    ids.push(docId);
    await cache.set(key(docId), answer);
  }
  const remaining = (await env.registry.list()).map((e) => e.docId);
  expect(remaining.sort()).toEqual([ids[1], ids[2]].sort());
  expect(await env.backend.hasDocument(ids[0] ?? '')).toBe(false);
  await expect(env.registry.getDocument(ids[0] ?? '')).rejects.toMatchObject({
    code: 'DOC_NOT_FOUND',
  });
  expect(await cache.get(key(ids[0]!))).toBeUndefined();
  expect(await cache.get(key(ids[1]!))).toEqual(answer);
  expect(await cache.get(key(ids[2]!))).toEqual(answer);
});

test('a wrapper page propagates with its candidate links', async () => {
  const links = [
    { url: 'https://example.gov/bill.pdf', text: 'PDF', format: 'pdf' },
  ];
  const fetcher = vi
    .fn()
    .mockRejectedValue(
      new AppError('WRAPPER_PAGE', undefined, { details: { links } }),
    );
  const error = await ingest(
    'https://example.gov/wrapper',
    deps({ fetcher }),
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: 'WRAPPER_PAGE', details: { links } });
});

test('scanned PDFs, unknown formats and parser crashes are explicit errors', async () => {
  env.serve(
    'https://example.gov/scan.pdf',
    await makeScannedPdf(),
    'application/pdf',
  );
  await expect(
    ingest('https://example.gov/scan.pdf', deps()),
  ).rejects.toMatchObject({
    code: 'SCANNED_PDF',
  });
  const pdf = await makeFederalStylePdf();
  env.serve('https://example.gov/a.pdf', pdf, 'application/pdf');
  await expect(
    ingest(
      'https://example.gov/a.pdf',
      deps({
        parsePdf: () => {
          throw new Error('boom');
        },
      }),
    ),
  ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
  env.serve('https://example.gov/blob', {
    bytes: Uint8Array.from([0, 1, 2, 255, 254]),
  });
  await expect(
    ingest('https://example.gov/blob', deps()),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_FORMAT',
  });
  expect(await env.registry.list()).toEqual([]);
});

test('the real PDF parser is the default', async () => {
  env.serve(
    'https://example.gov/a.pdf',
    await makeFederalStylePdf(),
    'application/pdf',
  );
  const result = await ingest('https://example.gov/a.pdf', deps());
  expect(result.stats.format).toBe('pdf');
});

test('a failed upsert deletes the namespace and surfaces an AppError', async () => {
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  vi.spyOn(env.backend, 'upsertChunks').mockRejectedValue(
    new Error('disk full'),
  );
  const remove = vi.spyOn(env.backend, 'deleteDocument');
  await expect(
    ingest('https://example.gov/s9001.xml', deps()),
  ).rejects.toMatchObject({
    code: 'BACKEND_UNAVAILABLE',
  });
  expect(remove).toHaveBeenCalledOnce();
  expect(await env.registry.list()).toEqual([]);
});

test('a fetcher that returns mismatched ids is rejected', async () => {
  env.serve(
    'https://example.gov/a.txt',
    { bytes: new TextEncoder().encode('Section 1. A\nOne.\n') },
    'text/plain',
  );
  const real = env.runtime.fetcher;
  const fetcher = vi.fn(async (url: string) => ({
    ...(await real(url)),
    docId: 'f'.repeat(64),
  }));
  await expect(
    ingest('https://example.gov/a.txt', deps({ fetcher })),
  ).rejects.toMatchObject({
    code: 'FETCH_FAILED',
  });
});

test('an aborted ingest stops without indexing', async () => {
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  const controller = new AbortController();
  controller.abort();
  await expect(
    ingest('https://example.gov/s9001.xml', deps(), {
      signal: controller.signal,
    }),
  ).rejects.toBeDefined();
  expect(await env.registry.list()).toEqual([]);
});

test('metadata extraction usage is reported', async () => {
  env.serve(
    'https://example.gov/gardens.txt',
    makeSectionedText(),
    'text/plain',
  );
  const real = env.provider.generateObject.bind(env.provider);
  vi.spyOn(env.provider, 'generateObject').mockImplementation(async (req) => {
    const out = await real(req);
    return { ...out, usage: { inputTokens: 7, outputTokens: 3 } };
  });
  const result = await ingest('https://example.gov/gardens.txt', deps());
  expect(result.usage).toMatchObject({ llmInputTokens: 7, llmOutputTokens: 3 });
  expect((await env.registry.list())[0]?.usage).toMatchObject({
    llmInputTokens: 7,
    llmOutputTokens: 3,
  });
});

const textSample = (body: string) => ({
  bytes: new TextEncoder().encode(`Section 1. T\n${body}\n`),
});

test('racing ingests of one document are serialized; an aborted one leaves the index intact', async () => {
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  const controller = new AbortController();
  const aborted = ingest('https://example.gov/s9001.xml', deps(), {
    signal: controller.signal,
    onProgress: (p) => {
      if (p.stage === 'embedding' && p.done === p.total) controller.abort();
    },
  }).catch((e: unknown) => e);
  const winner = ingest('https://example.gov/s9001.xml', deps());
  const [first, second] = await Promise.all([aborted, winner]);
  expect(first).toBeDefined();
  expect(second).toMatchObject({ stats: { reused: false } });
  const [entry] = await env.registry.list();
  expect(entry).toBeDefined();
  expect(await env.backend.hasDocument(entry?.docId ?? '')).toBe(true);
});

test('cleanup does not delete a namespace another process registered meanwhile', async () => {
  env.serve('https://example.gov/a.txt', textSample('One.'), 'text/plain');
  const registry = env.registry;
  const realAdd = registry.add.bind(registry);
  vi.spyOn(registry, 'add').mockImplementationOnce(async (doc, o) => {
    // Simulate another process winning the race, then this add failing.
    await realAdd(doc, { ...o, label: 'other-process' });
    throw new AppError('INVALID_INPUT');
  });
  await expect(
    ingest('https://example.gov/a.txt', deps()),
  ).rejects.toBeInstanceOf(AppError);
  const [entry] = await registry.list();
  expect(await env.backend.hasDocument(entry?.docId ?? '')).toBe(true);
});

test('concurrent ingests of different documents never exceed the cap', async () => {
  const urls = ['a', 'b', 'c', 'd'].map((n) => `https://example.gov/${n}.txt`);
  for (const [i, url] of urls.entries())
    env.serve(url, textSample(`Doc ${String(i)}.`), 'text/plain');
  await Promise.all(urls.map((url) => ingest(url, deps({ maxDocs: 2 }))));
  const entries = await env.registry.list();
  expect(entries.length).toBeLessThanOrEqual(2);
  for (const e of entries)
    expect(await env.backend.hasDocument(e.docId)).toBe(true);
});

test('a failed ingest at the cap does not evict anyone', async () => {
  env.serve('https://example.gov/a.txt', textSample('One.'), 'text/plain');
  env.serve('https://example.gov/b.txt', textSample('Two.'), 'text/plain');
  const a = await ingest('https://example.gov/a.txt', deps({ maxDocs: 1 }));
  vi.spyOn(env.backend, 'upsertChunks').mockRejectedValue(
    new Error('disk full'),
  );
  await expect(
    ingest('https://example.gov/b.txt', deps({ maxDocs: 1 })),
  ).rejects.toBeInstanceOf(AppError);
  expect((await env.registry.list()).map((e) => e.docId)).toEqual([
    a.doc.docId,
  ]);
  expect(await env.backend.hasDocument(a.doc.docId)).toBe(true);
});

test('a taken label fails right after the fetch, before any spend', async () => {
  env.serve('https://example.gov/a.txt', textSample('One.'), 'text/plain');
  env.serve('https://example.gov/b.txt', textSample('Two.'), 'text/plain');
  await ingest('https://example.gov/a.txt', deps(), { label: 'garden' });
  const calls = env.embedder.calls.length;
  const generate = vi.spyOn(env.provider, 'generateObject');
  const upsert = vi.spyOn(env.backend, 'upsertChunks');
  await expect(
    ingest('https://example.gov/b.txt', deps(), { label: 'garden' }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(generate).not.toHaveBeenCalled();
  expect(upsert).not.toHaveBeenCalled();
  expect(env.embedder.calls.length).toBe(calls);
});

test('re-indexing a known document makes no LLM call, refreshes recency and counts usage', async () => {
  env.serve('https://example.gov/a.txt', textSample('One.'), 'text/plain');
  const first = await ingest('https://example.gov/a.txt', deps());
  const [before] = await env.registry.list();
  await env.backend.deleteDocument(first.doc.docId);
  const generate = vi.spyOn(env.provider, 'generateObject');
  const again = await ingest('https://example.gov/a.txt', deps());
  expect(generate).not.toHaveBeenCalled();
  expect(again.stats.reused).toBe(false);
  expect(again.normalized.metadata).toEqual(first.normalized.metadata);
  const [after] = await env.registry.list();
  expect((after?.lastUsedAt ?? '') > (before?.lastUsedAt ?? '')).toBe(true);
  expect(after?.usage.embedTokens).toBe(
    (before?.usage.embedTokens ?? 0) + again.stats.embedTokens,
  );
});

test('a namespace left by a crash before registration skips metadata extraction', async () => {
  env.serve('https://example.gov/a.txt', textSample('One.'), 'text/plain');
  const first = await ingest('https://example.gov/a.txt', deps());
  await env.registry.remove(first.doc.docId); // index stays, as after a crash before add
  const generate = vi.spyOn(env.provider, 'generateObject');
  const upsert = vi.spyOn(env.backend, 'upsertChunks');
  const again = await ingest('https://example.gov/a.txt', deps());
  expect(generate).not.toHaveBeenCalled();
  expect(again.normalized.warnings.join(' ')).toMatch(/interrupted/);
  expect(await env.registry.list()).toHaveLength(1);
  // Local upsert skips unchanged vectors, so the re-run embeds nothing.
  expect(again.stats.embedTokens).toBe(0);
  expect(upsert).toHaveBeenCalledOnce();
});

test('eviction leaves entries of another backend alone rather than orphaning them', async () => {
  env.serve('https://example.gov/a.txt', textSample('One.'), 'text/plain');
  env.serve('https://example.gov/b.txt', textSample('Two.'), 'text/plain');
  const a = await ingest('https://example.gov/a.txt', deps());
  const remove = vi.spyOn(env.registry, 'remove');
  const foreign = { ...deps().backend, kind: 'pinecone' as const };
  Object.setPrototypeOf(foreign, env.backend);
  const b = await ingest(
    'https://example.gov/b.txt',
    deps({ backend: foreign, maxDocs: 1 }),
  );
  expect(remove).not.toHaveBeenCalled();
  expect((await env.registry.list()).map((e) => e.docId).sort()).toEqual(
    [a.doc.docId, b.doc.docId].sort(),
  );
});

test('metadata text does not repeat header lines that the body already starts with', async () => {
  const seen: string[] = [];
  const real = env.provider.generateObject.bind(env.provider);
  vi.spyOn(env.provider, 'generateObject').mockImplementation((req) => {
    seen.push(req.prompt);
    return real(req);
  });
  env.serve(
    'https://example.gov/a.txt',
    {
      bytes: new TextEncoder().encode(
        'Section 1. Short title\nShort title of the act.\nSection 2. Grants\nMore.\n',
      ),
    },
    'text/plain',
  );
  await ingest('https://example.gov/a.txt', deps());
  expect(seen).toHaveLength(1);
  expect(seen[0]?.match(/Short title/g)).toHaveLength(2); // heading line + body, not three times
});
