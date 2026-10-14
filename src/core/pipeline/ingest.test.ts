import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makeAmendmentHtml,
  makeAmendingBillPdf,
  makeCongressionalBillXml,
  makeFederalStylePdf,
  makeSectionedText,
} from '../../../tests/synth/index.js';
import {
  makePipelineEnv,
  stubPdfParser,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import { AppError } from '../model/index.js';
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
  const embedCalls = env.embedder.calls.length;
  const generate = vi.spyOn(env.provider, 'generateObject');
  const upsert = vi.spyOn(env.backend, 'upsertChunks');

  // Same bytes at another URL are the same document.
  env.serve('https://mirror.example.gov/copy.xml', makeCongressionalBillXml());
  const second = await ingest('https://mirror.example.gov/copy.xml', deps());

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

test('evicts the least recently used documents beyond the cap, from index and registry', async () => {
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
    ids.push((await ingest(url, deps({ maxDocs: 2 }))).doc.docId);
  }
  const remaining = (await env.registry.list()).map((e) => e.docId);
  expect(remaining.sort()).toEqual([ids[1], ids[2]].sort());
  expect(await env.backend.hasDocument(ids[0] ?? '')).toBe(false);
  await expect(env.registry.getDocument(ids[0] ?? '')).rejects.toMatchObject({
    code: 'DOC_NOT_FOUND',
  });
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

test('PDF without a parser, unknown formats and parser crashes are explicit errors', async () => {
  const pdf = await makeFederalStylePdf();
  env.serve('https://example.gov/a.pdf', pdf, 'application/pdf');
  await expect(
    ingest('https://example.gov/a.pdf', deps()),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_FORMAT',
  });
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
