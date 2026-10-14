import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makeAmendmentHtml,
  makeCongressionalBillXml,
} from '../../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import { DECLINE_TEXT, type SearchHit } from '../model/index.js';
import { ask, type AskDeps, type ChipRunner } from './ask.js';
import { ingest } from './ingest.js';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

function askDeps(overrides: Partial<AskDeps> = {}): AskDeps {
  return {
    backend: env.backend,
    provider: env.provider,
    registry: env.registry,
    ...overrides,
  };
}
async function load(
  url: string,
  sample: Parameters<PipelineEnv['serve']>[1],
  type?: string,
) {
  env.serve(url, sample, type);
  const { runtime } = env;
  return (
    await ingest(url, {
      backend: runtime.backend,
      provider: runtime.extractProvider,
      registry: runtime.registry,
      fetcher: runtime.fetcher,
      now: runtime.now,
    })
  ).doc.docId;
}

test('answers a freeform question with valid citations, refs and recorded usage', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  const tokens: string[] = [];
  const result = await ask(
    docId,
    { question: 'What are the garden grants?' },
    askDeps(),
    { onToken: (t) => tokens.push(t) },
  );
  expect(result.mode).toBe('hybrid_rerank');
  expect(result.answer.declined).toBe(false);
  expect(result.answer.citations.length).toBeGreaterThan(0);
  expect(result.answer.citations.every((c) => c.valid)).toBe(true);
  expect(tokens.join('').length).toBeGreaterThan(0);
  expect(result.refs.length).toBeGreaterThan(0);
  const retrieved = new Set(result.refs.map((r) => r.sectionId));
  for (const c of result.answer.citations)
    expect(retrieved.has(c.sectionId)).toBe(true);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  const [entry] = await env.registry.list();
  expect(entry?.usage.rerankUnits).toBeGreaterThan(0);
});

test('respects the configured retrieval mode', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  const result = await ask(
    docId,
    { question: 'garden grants' },
    askDeps({ retrievalMode: 'sparse' }),
  );
  expect(result.mode).toBe('sparse');
});

test('declines when the document does not address the question', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  const result = await ask(
    docId,
    { question: 'zzzz qqqq xylophone' },
    askDeps({ retrievalMode: 'sparse' }),
  );
  expect(result.answer.text).toBe(DECLINE_TEXT);
  expect(result.answer.declined).toBe(true);
});

test('struck text never reaches a default answer, but does for change questions', async () => {
  const docId = await load(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
  const normal = await ask(
    docId,
    { question: 'What are the permit fees?' },
    askDeps(),
  );
  const live = await env.backend.getChunks(
    docId,
    normal.refs.map((r) => r.chunkId),
  );
  expect(live.length).toBeGreaterThan(0);
  expect(live.every((c) => c.amendmentStatus !== 'deleted')).toBe(true);
  expect(normal.answer.text).not.toMatch(/five dollars|twenty dollars/);

  const changes = await ask(
    docId,
    { question: 'What fees were removed or struck?' },
    askDeps(),
  );
  const hits = await env.backend.getChunks(
    docId,
    changes.refs.map((r) => r.chunkId),
  );
  expect(hits.some((c) => c.amendmentStatus === 'deleted')).toBe(true);
});

test('even if the backend returns deleted chunks, a default question drops them', async () => {
  const docId = await load(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
  const real = env.backend.search.bind(env.backend);
  vi.spyOn(env.backend, 'search').mockImplementation(async (req) =>
    real({ ...req, filter: undefined }),
  );
  const result = await ask(
    docId,
    { question: 'permit fees dollars' },
    askDeps(),
  );
  const chunks = await env.backend.getChunks(
    docId,
    result.refs.map((r) => r.chunkId),
  );
  expect(chunks.every((c) => c.amendmentStatus !== 'deleted')).toBe(true);
});

test('rejects empty questions and unknown docs', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  await expect(
    ask(docId, { question: '   ' }, askDeps()),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    ask('a'.repeat(64), { question: 'hi' }, askDeps()),
  ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
});

test('chips default to the real chip strategies (no runner injected)', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  const tokens: string[] = [];
  const result = await ask(docId, { chipId: 'sponsors' }, askDeps(), {
    onToken: (t) => tokens.push(t),
  });
  // Sponsors is metadata-only: no retrieval, no model call, but the answer still streams.
  expect(result.mode).toBe('none');
  expect(result.answer.provider).toBe('none');
  expect(result.answer.text).toMatch(/sponsor/i);
  expect(tokens.join('')).toBe(result.answer.text);
});

test('chips dispatch through the injected runner and record its usage', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  const runner = vi.fn<ChipRunner>(async (_id, _docId, ctx, o) => {
    const found = await ctx.backend.search({
      docId,
      index: 'sparse',
      query: 'garden group nonprofit',
      topK: 3,
    });
    o.onToken?.('chip answer');
    return {
      answer: {
        text: 'chip answer',
        citations: [],
        invalidCitations: [],
        warnings: [],
        declined: false,
        readingGrade: null,
        provider: 'mock',
        model: 'mock',
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      hits: found.hits.map((h: SearchHit) => ({ ...h, injected: false })),
      backendUsage: {
        embedTokens: 3,
        rerankUnits: 1,
        readUnits: 0,
        writeUnits: 0,
      },
    };
  });
  const tokens: string[] = [];
  const result = await ask(
    docId,
    { chipId: 'summary' },
    askDeps({ chips: runner }),
    {
      onToken: (t) => tokens.push(t),
    },
  );
  expect(runner).toHaveBeenCalledOnce();
  expect(tokens).toEqual(['chip answer']);
  expect(result.refs.length).toBeGreaterThan(0);
  const [entry] = await env.registry.list();
  expect(entry?.usage).toMatchObject({
    llmInputTokens: 5,
    llmOutputTokens: 2,
    rerankUnits: 1,
  });
});

test('a registry entry without an index is a clear error, not a silent decline', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  await env.backend.deleteDocument(docId);
  await expect(
    ask(docId, { question: 'garden grants' }, askDeps()),
  ).rejects.toMatchObject({
    code: 'DOC_NOT_FOUND',
    userMessage: expect.stringContaining('Run ingest again') as string,
  });
});

test('chips that never retrieve load nothing and report mode none', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  await env.backend.deleteDocument(docId); // would fail any retrieval
  const ready = vi.spyOn(env.backend, 'ensureReady');
  const runner = vi.fn<ChipRunner>(() =>
    Promise.resolve({
      answer: {
        text: 'Sponsors: none stated.',
        citations: [],
        invalidCitations: [],
        warnings: [],
        declined: false,
        readingGrade: null,
        provider: 'none',
        model: 'none',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      hits: [],
      backendUsage: {
        embedTokens: 0,
        rerankUnits: 0,
        readUnits: 0,
        writeUnits: 0,
      },
    }),
  );
  const result = await ask(
    docId,
    { chipId: 'sponsors' },
    askDeps({ chips: runner }),
  );
  expect(result.mode).toBe('none');
  expect(ready).not.toHaveBeenCalled();
});

test('chip answers report the runner mode, else the configured one when retrieval ran', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  const answerStub = {
    text: 't',
    citations: [],
    invalidCitations: [],
    warnings: [],
    declined: false,
    readingGrade: null,
    provider: 'mock',
    model: 'mock',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const usage = { embedTokens: 0, rerankUnits: 0, readUnits: 0, writeUnits: 0 };
  const explicit = vi.fn<ChipRunner>(() =>
    Promise.resolve({
      answer: answerStub,
      hits: [],
      backendUsage: usage,
      mode: 'dense' as const,
    }),
  );
  expect(
    (await ask(docId, { chipId: 'definitions' }, askDeps({ chips: explicit })))
      .mode,
  ).toBe('dense');
  const retrieving = vi.fn<ChipRunner>(async (_i, id, ctx) => {
    await ctx.backend.search({
      docId: id,
      index: 'sparse',
      query: 'garden',
      topK: 1,
    });
    return { answer: answerStub, hits: [], backendUsage: usage };
  });
  const result = await ask(
    docId,
    { chipId: 'penalties' },
    askDeps({ chips: retrieving, retrievalMode: 'hybrid' }),
  );
  expect(result.mode).toBe('hybrid');
});
