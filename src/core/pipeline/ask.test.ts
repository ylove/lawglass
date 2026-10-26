import { envVar } from '../brand.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  makeAmendmentHtml,
  makeCongressionalBillXml,
} from '../../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import {
  scenarioProvider,
  type ScenarioProvider,
} from '../../../tests/support/scenario-provider.js';
import {
  AppError,
  DECLINE_TEXT,
  type AnswerResult,
  type Section,
  type SearchHit,
} from '../model/index.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { ask, type AskDeps, type ChipRunner } from './ask.js';
import { writeHistory } from '../history/history-store.js';
import { ingest } from './ingest.js';
import { Limits } from './limits.js';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

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

describe('inline struck text', () => {
  // A provider that answers with the excerpts it was shown, to prove what reached the model.
  const echo = () =>
    new ScriptedProvider({
      reply: (req) => {
        const content = req.messages[0]?.content;
        const shown = typeof content === 'string' ? content : '';
        // Cites a real section and an invented one, to exercise validation.
        return `${shown}\nThe fee changed [S:sec-1] [S:made-up].`;
      },
    });

  test('a change question sees struck and inserted words in place; citations still validate', async () => {
    const docId = await load(
      'https://example.gov/permit.html',
      makeAmendmentHtml(),
      'text/html',
    );
    const provider = echo();
    const result = await ask(
      docId,
      { question: 'What fees were struck?' },
      askDeps({ provider }),
    );
    const sent = result.answer.text;
    expect(sent).toContain('[struck]five dollars[/struck]');
    expect(sent).toContain('[inserted]six dollars[/inserted]');
    expect(sent).toContain('section="sec-1"');
    expect(result.answer.citations.map((c) => c.sectionId)).toContain('sec-1');
    expect(result.answer.invalidCitations).toEqual(['made-up']);
    // Inline excerpts are synthetic, so their ids must not leak into citations.
    expect(result.answer.citations.length).toBeGreaterThan(0);
    for (const c of result.answer.citations)
      expect(c.chunkIds.some((id) => id.includes(':~'))).toBe(false);
  });

  test('an ordinary question never sees struck text or markers', async () => {
    const docId = await load(
      'https://example.gov/permit.html',
      makeAmendmentHtml(),
      'text/html',
    );
    const result = await ask(
      docId,
      { question: 'What are the permit fees?' },
      askDeps({ provider: echo() }),
    );
    expect(result.answer.text).toContain('<excerpt');
    expect(result.answer.text).not.toMatch(/\[struck\]|five dollars/);
  });
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

test('the history chip reads the stored sidecar, and says so when there is none', async () => {
  const docId = await load(
    'https://example.gov/s9002.xml',
    makeCongressionalBillXml(),
  );
  const none = await ask(docId, { chipId: 'history' }, askDeps());
  expect(none.answer.text).toContain("Legislative history isn't available");
  expect(none.answer.provider).toBe('none');
  await writeHistory(env.registry.configDir, docId, {
    versions: [],
    actions: [
      {
        date: '2026-01-02',
        text: 'Introduced in the Senate.',
        chamber: 'Senate',
      },
    ],
    amendments: [],
    sources: [],
  });
  const some = await ask(docId, { chipId: 'history' }, askDeps());
  expect(some.answer.text).toContain('2026-01-02: Introduced in the Senate.');
  expect(some.mode).toBe('none');
});

test('a corrupt history sidecar reads as "not available" for the history chip', async () => {
  const docId = await load(
    'https://example.gov/s9003.xml',
    makeCongressionalBillXml(),
  );
  await mkdir(join(env.registry.configDir, 'history'), { recursive: true });
  await writeFile(
    join(env.registry.configDir, 'history', `${docId}.json`),
    '{not json',
  );
  const result = await ask(docId, { chipId: 'history' }, askDeps());
  expect(result.answer.text).toContain("Legislative history isn't available");
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
  const embedReady = vi.spyOn(env.embedder, 'ensureReady');
  const rerankReady = vi.spyOn(env.reranker, 'ensureReady');
  await expect(
    ask(docId, { question: 'garden grants' }, askDeps()),
  ).rejects.toMatchObject({
    code: 'DOC_NOT_FOUND',
    userMessage: expect.stringContaining('Run ingest again') as string,
  });
  expect(embedReady).not.toHaveBeenCalled();
  expect(rerankReady).not.toHaveBeenCalled();
});

test('backend initialization failure stops before retrieval', async () => {
  const docId = await load(
    'https://example.gov/s9001.xml',
    makeCongressionalBillXml(),
  );
  vi.spyOn(env.backend, 'ensureReady').mockRejectedValue(
    new AppError('BACKEND_UNAVAILABLE'),
  );
  const exists = vi.spyOn(env.backend, 'hasDocument');
  const search = vi.spyOn(env.backend, 'search');
  await expect(
    ask(docId, { question: 'garden grants' }, askDeps()),
  ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  expect(exists).toHaveBeenCalledOnce();
  expect(search).not.toHaveBeenCalled();
  expect(await env.registry.list()).toHaveLength(1);
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

// ---------------------------------------------------------------------------------------------
// Scenario attachment (#127)
// ---------------------------------------------------------------------------------------------

function scenarioDeps(
  overrides: Partial<AskDeps> = {},
): AskDeps & { provider: ScenarioProvider } {
  const provider = scenarioProvider(env.provider);
  return {
    ...askDeps(),
    provider,
    scenario: { enabled: true },
    ...overrides,
  } as AskDeps & {
    provider: ScenarioProvider;
  };
}

/** A chip runner that answers from one real chunk, so the scenario can cite it. */
async function runnerFor(docId: string): Promise<ChipRunner> {
  const probe = await ask(docId, { question: 'garden grants' }, askDeps());
  const base = probe.answer;
  const chunks = await env.backend.getChunks(
    docId,
    probe.refs.map((r) => r.chunkId),
  );
  const hits: SearchHit[] = chunks.map((chunk) => ({ chunk, score: 1 }));
  return () =>
    Promise.resolve({
      answer: base,
      hits,
      backendUsage: {
        embedTokens: 0,
        rerankUnits: 0,
        readUnits: 0,
        writeUnits: 0,
      },
      mode: 'none' as const,
    });
}

const BILL_URL = 'https://example.gov/s9001.xml';

test('an affect-me question gets a scenario after the answer text, and its usage is recorded', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps();
  const order: string[] = [];
  deps.provider.onScenario = () => order.push('scenario');
  const result = await ask(
    docId,
    { question: 'How will the garden grants affect my family?' },
    deps,
    { onToken: () => order.push('token') },
  );
  expect(result.answer.scenario?.frames.length).toBeGreaterThanOrEqual(3);
  expect(order.at(-1)).toBe('scenario');
  expect(order.filter((o) => o === 'scenario')).toHaveLength(1);
  expect(result.answer.usage.inputTokens).toBeGreaterThanOrEqual(5);
  const [entry] = await env.registry.list();
  expect(entry?.usage.llmInputTokens).toBe(result.answer.usage.inputTokens);
});

test('scenarios are off unless a caller turns them on (fails closed)', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps({ scenario: undefined });
  const result = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    deps,
  );
  expect(deps.provider.scenarioCalls).toBe(0);
  expect(result.answer.scenario).toBeUndefined();
});

test('deferScenario returns the answer first and delivers the scenario later', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = deps.provider;
  const real = inner.generateObject.bind(inner);
  deps.provider.behavior = async (req) => {
    await gate;
    deps.provider.behavior = undefined;
    return (await real(req)) as never;
  };
  const result = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    deps,
    { deferScenario: true },
  );
  // The answer is complete while generation is still blocked.
  expect(result.answer.declined).toBe(false);
  expect(result.answer.scenario).toBeUndefined();
  expect(result.scenario).toBeInstanceOf(Promise);
  release();
  const late = await result.scenario;
  expect(late?.frames.length).toBeGreaterThanOrEqual(3);
  const [entry] = await env.registry.list();
  expect(entry?.usage.llmInputTokens).toBeGreaterThanOrEqual(5);
});

test('deferScenario gives no promise when no scenario is wanted or enabled', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const plain = await ask(
    docId,
    { question: 'What are the garden grants?' },
    scenarioDeps(),
    { deferScenario: true },
  );
  expect(plain.scenario).toBeUndefined();
  const off = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    scenarioDeps({ scenario: { enabled: false } }),
    { deferScenario: true },
  );
  expect(off.scenario).toBeUndefined();
});

test('a deferred scenario that fails resolves to undefined', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps();
  deps.provider.behavior = () => Promise.reject(new AppError('PROVIDER_ERROR'));
  const result = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    deps,
    { deferScenario: true },
  );
  await expect(result.scenario).resolves.toBeUndefined();
});

test('a plain question makes no scenario call', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps();
  const result = await ask(
    docId,
    { question: 'What are the garden grants?' },
    deps,
  );
  expect(deps.provider.scenarioCalls).toBe(0);
  expect(result.answer.scenario).toBeUndefined();
});

test('a failing scenario leaves the answer intact', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const plain = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    askDeps(),
  );
  const deps = scenarioDeps();
  deps.provider.behavior = () => Promise.reject(new AppError('PROVIDER_ERROR'));
  const result = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    deps,
  );
  expect(deps.provider.scenarioCalls).toBe(1);
  expect(result.answer.scenario).toBeUndefined();
  expect(result.answer.text).toBe(plain.answer.text);
  expect(result.answer.citations).toEqual(plain.answer.citations);
});

test('a hung scenario is cut off by the timeout', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps({ scenario: { timeoutMs: 20 } });
  deps.provider.behavior = (req) =>
    new Promise((_, reject) => {
      req.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  const result = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    deps,
  );
  expect(result.answer.scenario).toBeUndefined();
  expect(result.answer.declined).toBe(false);
});

test('disabled (public mode) never generates, even for an affect-me question', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps({ scenario: { enabled: false } });
  const result = await ask(
    docId,
    { question: 'How will garden grants affect me?' },
    deps,
  );
  expect(deps.provider.scenarioCalls).toBe(0);
  expect(result.answer.scenario).toBeUndefined();
});

test('a declined answer gets no scenario', async () => {
  const docId = await load(BILL_URL, makeCongressionalBillXml());
  const deps = scenarioDeps({ retrievalMode: 'sparse' });
  const result = await ask(
    docId,
    { question: 'zzzz qqqq xylophone, how does it affect me' },
    deps,
  );
  expect(result.answer.declined).toBe(true);
  expect(deps.provider.scenarioCalls).toBe(0);
});

describe('chip attachment', () => {
  const omnibus = (): Section[] =>
    ['A', 'B', 'C'].map(
      (d) =>
        ({
          id: `div-${d}`,
          heading: `Division ${d}`,
          level: 1,
          spans: [],
          children: [
            {
              id: `sec-${d}`,
              heading: 'Topic',
              level: 2,
              spans: [{ text: 'x', status: 'unchanged' }],
              children: [],
            },
          ],
        }) as unknown as Section,
    );

  test.each([
    ['who-affected', true],
    ['summary', true],
    ['penalties', false],
    ['effective-date', false],
  ] as const)('%s on a focused bill: scenario=%s', async (chipId, expected) => {
    const docId = await load(BILL_URL, makeCongressionalBillXml());
    const chips = await runnerFor(docId);
    const doc = await env.registry.getDocument(docId);
    vi.spyOn(env.registry, 'getDocument').mockResolvedValue({
      ...doc,
      sections: [
        {
          id: 'sec-1',
          heading: 'Garden grants',
          level: 1,
          spans: [{ text: 'x', status: 'unchanged' }],
          children: [],
        } as unknown as Section,
      ],
    });
    const deps = scenarioDeps({ chips });
    const result = await ask(docId, { chipId }, deps);
    expect(result.answer.scenario !== undefined).toBe(expected);
    expect(deps.provider.scenarioCalls).toBe(expected ? 1 : 0);
  });

  test('summary of an omnibus bill stays descriptive, but who-affected still tries', async () => {
    const docId = await load(BILL_URL, makeCongressionalBillXml());
    const chips = await runnerFor(docId);
    const doc = await env.registry.getDocument(docId);
    vi.spyOn(env.registry, 'getDocument').mockResolvedValue({
      ...doc,
      sections: omnibus(),
    });
    const deps = scenarioDeps({ chips });
    expect(
      (await ask(docId, { chipId: 'summary' }, deps)).answer.scenario,
    ).toBeUndefined();
    expect(deps.provider.scenarioCalls).toBe(0);
    expect(
      (await ask(docId, { chipId: 'who-affected' }, deps)).answer.scenario,
    ).toBeDefined();
  });

  test('chips in disabled mode never generate', async () => {
    const docId = await load(BILL_URL, makeCongressionalBillXml());
    const chips = await runnerFor(docId);
    const deps = scenarioDeps({ chips, scenario: { enabled: false } });
    await ask(docId, { chipId: 'who-affected' }, deps);
    expect(deps.provider.scenarioCalls).toBe(0);
  });
});

describe('budgets and question hygiene (LLM10)', () => {
  const stubAnswer: AnswerResult = {
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
  const noUsage = {
    embedTokens: 0,
    rerankUnits: 0,
    readUnits: 0,
    writeUnits: 0,
  };

  test('enforces the 500-character cap in core, before any retrieval or model call', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const search = vi.spyOn(env.backend, 'search');
    const provider = vi.spyOn(env.provider, 'streamText');
    await expect(
      ask(docId, { question: 'x'.repeat(501) }, askDeps()),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      userMessage: 'Keep the question to 500 characters or fewer.',
    });
    expect(search).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  test('strips invisible characters before retrieval and the prompt', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const search = vi.spyOn(env.backend, 'search');
    const stream = vi.spyOn(env.provider, 'streamText');
    await ask(docId, { question: 'garden​ grants ‮drowssap' }, askDeps());
    const queries = search.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).not.toMatch(/[​‮]/);
    for (const call of stream.mock.calls)
      expect(JSON.stringify(call[0])).not.toMatch(/\\u200b|\\u202e|[​‮]/);
  });

  test('a rejected question does not use up the per-minute ceiling', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 4, maxCallsPerMinute: 1 },
      () => 0,
    );
    await expect(
      ask(docId, { question: '  ' }, askDeps({ limits })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      ask(docId, { question: 'garden grants' }, askDeps({ limits })),
    ).resolves.toBeDefined();
  });

  test('queues asks beyond the concurrency limit', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const runner = vi.fn<ChipRunner>(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => releases.push(r));
      running -= 1;
      return { answer: stubAnswer, hits: [], backendUsage: noUsage };
    });
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 2, maxCallsPerMinute: 1 },
      () => 0,
    );
    const deps = askDeps({ chips: runner, limits });
    const runs = Array.from({ length: 4 }, () =>
      ask(docId, { chipId: 'sponsors' }, deps),
    );
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(2);
    });
    expect(running).toBe(2); // the other two are queued, not failed
    const state = { done: false };
    const all = Promise.all(runs).then(() => (state.done = true));
    while (!state.done) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await all;
    expect(peak).toBe(2);
    expect(runner).toHaveBeenCalledTimes(4);
  });

  test('chips that make no model call cost nothing against the per-minute ceiling', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 4, maxCallsPerMinute: 1 },
      () => 0,
    );
    const stream = vi.spyOn(env.provider, 'streamText');
    for (let i = 0; i < 5; i += 1)
      await ask(docId, { chipId: 'sponsors' }, askDeps({ limits }));
    expect(stream).not.toHaveBeenCalled();
    // The one model call the ceiling allows is still available afterwards.
    await expect(
      ask(docId, { question: 'garden grants' }, askDeps({ limits })),
    ).resolves.toBeDefined();
  });

  test('charges every provider call, not each ask: a second model call past the ceiling is refused', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 4, maxCallsPerMinute: 1 },
      () => 0,
    );
    const stream = vi.spyOn(env.provider, 'streamText');
    await ask(docId, { question: 'garden grants' }, askDeps({ limits }));
    expect(stream).toHaveBeenCalledTimes(1);
    await expect(
      ask(docId, { question: 'garden grants again' }, askDeps({ limits })),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(stream).toHaveBeenCalledTimes(1); // refused before reaching the model
  });

  test('the delegations lede is a metered model call, in whole-bill mode too', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 4, maxCallsPerMinute: 1 },
      () => 0,
    );
    const stream = vi.spyOn(env.provider, 'streamText');
    // A huge whole-bill budget must not matter: the lede reads only the extracted quotes.
    const deps = askDeps({ limits, wholeBillMaxTokens: 1_000_000 });
    const first = await ask(docId, { chipId: 'delegations' }, deps);
    expect(first.answer.text.length).toBeGreaterThan(0);
    const calls = stream.mock.calls.length;
    expect(calls).toBe(1);
    // Past the ceiling the lede is refused, but the list needs no model: it still answers.
    const second = await ask(docId, { chipId: 'delegations' }, deps);
    expect(second.answer.text).toContain('**');
    expect(second.answer.provider).toBe('none');
    expect(stream.mock.calls.length).toBe(calls);
  });

  test('a multi-call summary is charged per provider call', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 4, maxCallsPerMinute: 2 },
      () => 0,
    );
    // A runner that makes three model calls through the provider it is handed.
    const runner: ChipRunner = async (_chip, _doc, ctx) => {
      for (let i = 0; i < 3; i += 1)
        await collect(
          ctx.provider.streamText({
            system: 's',
            messages: [{ role: 'user', content: 'q' }],
            maxTokens: 10,
          }),
        );
      return { answer: stubAnswer, hits: [], backendUsage: noUsage };
    };
    await expect(
      ask(docId, { chipId: 'summary' }, askDeps({ chips: runner, limits })),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // The failed ask released its permit.
    expect(limits.pool('ask').inFlight).toBe(0);
  });

  test('a deferred scenario keeps its ask permit until it settles', async () => {
    const docId = await load(BILL_URL, makeCongressionalBillXml());
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 1, maxCallsPerMinute: 100 },
      () => 0,
    );
    const deps = scenarioDeps({ limits });
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const real = deps.provider.generateObject.bind(deps.provider);
    deps.provider.behavior = async (req) => {
      await gate;
      deps.provider.behavior = undefined;
      return (await real(req)) as never;
    };
    const first = await ask(
      docId,
      { question: 'How will garden grants affect me?' },
      deps,
      { deferScenario: true },
    );
    expect(first.scenario).toBeInstanceOf(Promise);
    // The answer is back but the scenario is still running: the permit is still held.
    expect(limits.pool('ask').inFlight).toBe(1);
    let secondStarted = false;
    const second = ask(docId, { question: 'garden grants' }, deps).then(() => {
      secondStarted = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondStarted).toBe(false);
    expect(limits.pool('ask').queued).toBe(1);
    open();
    await first.scenario;
    await second;
    expect(limits.pool('ask').inFlight).toBe(0);
  });

  test('a deferred scenario keeps the permit even when the ask fails after starting it', async () => {
    const docId = await load(BILL_URL, makeCongressionalBillXml());
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 1, maxCallsPerMinute: 100 },
      () => 0,
    );
    const deps = scenarioDeps({ limits });
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const real = deps.provider.generateObject.bind(deps.provider);
    deps.provider.behavior = async (req) => {
      await gate;
      deps.provider.behavior = undefined;
      return (await real(req)) as never;
    };
    vi.spyOn(env.registry, 'touch').mockRejectedValueOnce(
      new AppError('DOC_NOT_FOUND'),
    );
    await expect(
      ask(docId, { question: 'How will garden grants affect me?' }, deps, {
        deferScenario: true,
      }),
    ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
    // The scenario's model call is still running, so the permit is still held.
    expect(limits.pool('ask').inFlight).toBe(1);
    open();
    await vi.waitFor(() => {
      expect(limits.pool('ask').inFlight).toBe(0);
    });
  });

  test('a failed ask releases its permit', async () => {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const limits = new Limits(
      { maxConcurrentIngest: 2, maxConcurrentAsk: 1, maxCallsPerMinute: 100 },
      () => 0,
    );
    const boom: ChipRunner = () =>
      Promise.reject(new AppError('PROVIDER_ERROR'));
    await expect(
      ask(docId, { chipId: 'summary' }, askDeps({ chips: boom, limits })),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(limits.pool('ask').inFlight).toBe(0);
  });
});
// These tests pin the retained retrieval/outline strategies.
beforeEach(() => vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '0'));
afterEach(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------------------------
// Reading level (#285)
// ---------------------------------------------------------------------------------------------

describe('reading level', () => {
  const hardFor = (id: string) =>
    `The Administrator shall promulgate regulations establishing eligibility requirements for participating municipalities, which must demonstrate substantial compliance with applicable environmental standards [S:${id}]. Each qualifying municipality receives $50,000 annually for 3 years [S:${id}].`;
  const easyFor = (id: string) =>
    `The agency must write rules. Towns must follow them to take part [S:${id}]. Each town gets $50,000 each year for 3 years [S:${id}].`;

  /** Hard on the first try, easy once the plain-language instruction is in the prompt. */
  function hardThenEasy(id: string, second?: string) {
    return new ScriptedProvider({
      reply: (req) =>
        JSON.stringify(req.messages).includes('6th-grade reader')
          ? (second ?? easyFor(id))
          : hardFor(id),
    });
  }

  async function setup() {
    const docId = await load(
      'https://example.gov/s9001.xml',
      makeCongressionalBillXml(),
    );
    const question = 'What are the garden grants?';
    const probe = await ask(docId, { question }, askDeps());
    const id = probe.answer.citations[0]?.sectionId ?? '';
    expect(id).not.toBe('');
    return { docId, question, id };
  }

  test('a freeform answer above the ceiling is regenerated, and the usage is added and recorded', async () => {
    const { docId, question, id } = await setup();
    const [before] = await env.registry.list();
    const provider = hardThenEasy(id);
    const result = await ask(
      docId,
      { question },
      askDeps({ provider, readingLevel: { maxGrade: 8 } }),
    );
    expect(result.answer.text).toBe(easyFor(id));
    expect(result.answer.simplified).toBe(true);
    expect(result.answer.readingGrade).toBeLessThan(8);
    expect(result.answer.citations.map((c) => c.sectionId)).toEqual([id]);
    expect(provider.calls).toHaveLength(2);
    expect(result.answer.usage.inputTokens).toBe(2);
    const [after] = await env.registry.list();
    expect(after?.usage.llmInputTokens).toBeGreaterThan(
      before?.usage.llmInputTokens ?? 0,
    );
  });

  test('no second call when readingLevel is unset, the ceiling is 0, or the answer is easy enough', async () => {
    const { docId, question, id } = await setup();
    for (const readingLevel of [undefined, { maxGrade: 0 }, { maxGrade: 99 }]) {
      const provider = hardThenEasy(id);
      const r = await ask(
        docId,
        { question },
        askDeps({ provider, readingLevel }),
      );
      expect(r.answer.simplified).toBeUndefined();
      expect(provider.calls).toHaveLength(1);
    }
  });

  test('the second call is metered: past the per-minute ceiling the first answer is kept', async () => {
    const { docId, question, id } = await setup();
    const limits = (max: number) =>
      new Limits({
        maxConcurrentIngest: 1,
        maxConcurrentAsk: 1,
        maxCallsPerMinute: max,
      });
    const lines: unknown[] = [];
    const refused = hardThenEasy(id);
    const r1 = await ask(
      docId,
      { question },
      askDeps({
        provider: refused,
        readingLevel: { maxGrade: 8 },
        limits: limits(1),
        log: (l) => lines.push(l),
      }),
    );
    expect(r1.answer.text).toBe(hardFor(id));
    expect(refused.calls).toHaveLength(1);
    expect(lines).toContainEqual({
      event: 'regeneration_refused',
      reason: 'ERROR',
    });

    const r2 = await ask(
      docId,
      { question },
      askDeps({
        provider: hardThenEasy(id),
        readingLevel: { maxGrade: 8 },
        limits: limits(2),
      }),
    );
    expect(r2.answer.simplified).toBe(true);
  });

  test('a refused regeneration is logged and the first answer stands', async () => {
    const { docId, question, id } = await setup();
    const lines: unknown[] = [];
    const r = await ask(
      docId,
      { question },
      askDeps({
        provider: hardThenEasy(id, 'Towns get money.'),
        readingLevel: { maxGrade: 8 },
        log: (l) => lines.push(l),
      }),
    );
    expect(r.answer.text).toBe(hardFor(id));
    expect(lines).toEqual([
      { event: 'regeneration_refused', reason: 'NO_CITATION' },
    ]);
  });

  test('a question about changes is not regenerated', async () => {
    const { docId, id } = await setup();
    const provider = hardThenEasy(id);
    const r = await ask(
      docId,
      { question: 'What does this bill strike or remove?' },
      askDeps({ provider, readingLevel: { maxGrade: 8 } }),
    );
    expect(r.answer.simplified).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
  });

  test('chips are regenerated; the changes chip and a chip with no model call are not', async () => {
    const { docId, id } = await setup();
    const summary = hardThenEasy(id);
    const s = await ask(
      docId,
      { chipId: 'summary' },
      askDeps({ provider: summary, readingLevel: { maxGrade: 8 } }),
    );
    expect(s.answer.simplified).toBe(true);
    expect(summary.calls).toHaveLength(2);

    const changes = hardThenEasy(id);
    const c = await ask(
      docId,
      { chipId: 'what-changes' },
      askDeps({ provider: changes, readingLevel: { maxGrade: 8 } }),
    );
    expect(c.answer.simplified).toBeUndefined();

    const sponsors = hardThenEasy(id);
    await ask(
      docId,
      { chipId: 'sponsors' },
      askDeps({ provider: sponsors, readingLevel: { maxGrade: 8 } }),
    );
    expect(sponsors.calls).toHaveLength(0);
  });
});
