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
  type Section,
  type SearchHit,
} from '../model/index.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { ask, type AskDeps, type ChipRunner } from './ask.js';
import { writeHistory } from '../history/history-store.js';
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
    ['summary', false],
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

  test('summary never carries an inline scenario (it is a separate default call); who-affected still tries', async () => {
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
