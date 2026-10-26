import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { scenarioProvider } from '../../../tests/support/scenario-provider.js';
import { envVar } from '../brand.js';
import { getChip, runChip } from '../chips.js';
import { INSTRUCTIONS_NOTE } from '../chip-runner.js';
import { answerCacheKey } from '../answer-cache.js';
import { SYSTEM_PROMPT, WHOLE_SYSTEM_PROMPT } from '../answer/prompt.js';
import {
  AskEvent,
  EMPTY_METADATA,
  makeChunkId,
  messageText,
  type Chunk,
  type NormalizedDoc,
  type Section,
  type TextRequest,
  type LlmProvider,
} from '../model/index.js';
import { Registry } from '../registry.js';
import { ask } from './ask.js';
import { runScenario } from './scenario.js';

const DOC = 'b'.repeat(64);
let dir: string;
let backend: MemoryBackend;
let registry: Registry;
let doc: NormalizedDoc;
let chunks: Chunk[];
let provider: ScriptedProvider;
const requests = (): TextRequest[] =>
  provider.calls.filter((c): c is TextRequest => 'messages' in c);

beforeEach(async () => {
  vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '100000');
  dir = await mkdtemp(join(tmpdir(), 'whole-bill-'));
  registry = new Registry(dir);
  backend = new MemoryBackend();
  const sections: Section[] = Array.from({ length: 12 }, (_, i) => ({
    id: `sec-${String(i + 1)}`,
    num: String(i + 1),
    level: 1,
    heading: `Part ${String(i + 1)}`,
    spans: [
      { text: `Part ${String(i + 1)} sets a rule.`, status: 'unchanged' },
    ],
    children: [],
  }));
  sections[11]!.spans = [
    {
      text: 'The term "eligible entity" means a town with a library.',
      status: 'unchanged',
    },
  ];
  doc = {
    docId: DOC,
    sourceUrl: 'https://example.gov/bill.xml',
    format: 'xml',
    fetchedAt: '2026-10-26T00:00:00.000Z',
    metadata: { ...EMPTY_METADATA, title: 'Library grants' },
    sections,
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
  chunks = sections.map((s): Chunk => ({
    id: makeChunkId(DOC, s.id, 0),
    docId: DOC,
    sectionId: s.id,
    breadcrumb: s.heading!,
    text: s.spans[0]!.text,
    embedText: s.spans[0]!.text,
    chunkType: s.id === 'sec-12' ? 'definition' : 'operative',
    amendmentStatus: 'unchanged',
    definedTermsUsed: [],
    refs: [],
    tokenCount: 10,
    ...(s.id === 'sec-12' ? { definesTerm: 'eligible entity' } : {}),
  }));
  provider = new ScriptedProvider({
    reply:
      'An eligible entity is a town with a library [S:sec-12]. Bad id [S:sec-999].',
  });
  await backend.upsertChunks(DOC, chunks);
  await registry.add(doc, { label: 'library', backend: 'local' });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('skips an empty retriever and validates a deep definition while removing nonexistent citations', async () => {
  const search = vi
    .spyOn(backend, 'search')
    .mockRejectedValue(new Error('retrieval must be skipped'));
  const ready = vi
    .spyOn(backend, 'ensureReady')
    .mockRejectedValue(new Error('models must not load'));
  const rerank = vi.spyOn(backend, 'rerank');
  const result = await ask(
    DOC,
    { question: 'Who can apply?' },
    { backend, registry, provider },
  );
  expect(result.answer.context).toBe('whole');
  expect(result.mode).toBe('whole');
  expect(result.refs).toEqual([]);
  expect(
    AskEvent.safeParse({
      type: 'retrieval',
      mode: result.mode,
      refs: result.refs,
      latencyMs: result.latencyMs,
    }).success,
  ).toBe(true);
  expect(
    result.answer.citations.find((c) => c.sectionId === 'sec-12'),
  ).toMatchObject({ valid: true, chunkIds: [makeChunkId(DOC, 'sec-12', 0)] });
  expect(result.answer.invalidCitations).toEqual(['sec-999']);
  expect(result.answer.text).not.toContain('[S:sec-999]');
  expect(search).not.toHaveBeenCalled();
  expect(rerank).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  expect(requests()[0]).toMatchObject({ maxTokens: 16000, effort: 'medium' });
});

it('records excerpts when disabled and preserves the old output budget', async () => {
  const result = await ask(
    DOC,
    { question: 'What rule?' },
    { backend, registry, provider, wholeBillMaxTokens: 0 },
  );
  expect(result.answer.context).toBe('excerpts');
  expect(requests()[0]).toMatchObject({
    maxTokens: 8192,
    system: SYSTEM_PROMPT,
  });
  expect(requests()[0]?.effort).toBeUndefined();
});

it('puts exactly one cached bill part before the question; two chips share identical system and bill prefixes', async () => {
  const anthropic: LlmProvider = {
    id: 'anthropic',
    model: provider.model,
    streamText: (request) => provider.streamText(request),
    generateObject: (request) => provider.generateObject(request),
  };
  for (const id of ['money', 'who-affected'] as const) {
    await runChip(getChip(id), DOC, { backend, provider: anthropic, doc });
  }
  const [a, b] = requests();
  expect(a!.system).toBe(WHOLE_SYSTEM_PROMPT);
  expect(a!.system).toBe(b!.system);
  expect(a!.messages[0]!.content[0]).toEqual(b!.messages[0]!.content[0]);
  for (const req of [a!, b!]) {
    const parts = req.messages[0]!.content;
    expect(typeof parts).not.toBe('string');
    if (typeof parts === 'string') throw new Error('Expected parts');
    expect(parts).toHaveLength(2);
    expect(parts.filter((p) => p.cache)).toHaveLength(1);
    expect(parts[0]).toMatchObject({ cache: true });
    expect(parts[0]!.text).toContain('<document title="Library grants"/>');
    expect(parts[0]!.text).toContain('kind="definition"');
    expect(parts[0]!.text.indexOf('section="sec-2"')).toBeLessThan(
      parts[0]!.text.indexOf('section="sec-12"'),
    );
    expect(parts[0]!.text).not.toMatch(/<question>|<task>/);
    expect(parts[1]!.cache).toBeUndefined();
    expect(parts[1]!.text).toContain('<task>');
    expect(parts[1]!.text).toContain('<question>');
  }
});

it('uses one whole-bill summary call and keeps map-reduce when one token over budget', async () => {
  const full = await runChip(
    getChip('summary'),
    DOC,
    { backend, provider, doc },
    { wholeBillMaxTokens: 120 },
  );
  expect(full.answer.context).toBe('whole');
  expect(provider.calls).toHaveLength(1);
  expect(messageText(requests()[0]!.messages[0]!.content)).toContain(
    'short paragraph, then a short list',
  );
  provider.calls.length = 0;
  provider = new ScriptedProvider({
    reply: (req) =>
      'A rule applies [S:' +
      (/section="([^"]+)"/.exec(messageText(req.messages[0]!.content))?.[1] ??
        'sec-1') +
      '].',
  });
  const partial = await runChip(
    getChip('summary'),
    DOC,
    { backend, provider, doc },
    { wholeBillMaxTokens: 119 },
  );
  expect(partial.answer.context).toBe('excerpts');
  expect(provider.calls).toHaveLength(3);
});

it('uses the whole bill for unmarked change instructions without the retrieval note', async () => {
  const result = await runChip(getChip('what-changes'), DOC, {
    backend,
    provider,
    doc,
  });
  expect(result.answer.context).toBe('whole');
  expect(result.answer.text).not.toContain(INSTRUCTIONS_NOTE);
  expect(messageText(requests()[0]!.messages[0]!.content)).toContain(
    'striking',
  );
});

it('keeps struck text out of ordinary questions and uses full inline markers for change questions', async () => {
  const section = doc.sections[0]!;
  section.spans = [
    { text: 'The fee is ', status: 'unchanged' },
    { text: 'five dollars', status: 'deleted' },
    { text: 'six dollars', status: 'inserted' },
    {
      text: '. ' + 'Full retained text. '.repeat(400) + 'End of section.',
      status: 'unchanged',
    },
  ];
  chunks[0] = {
    ...chunks[0]!,
    text: 'The fee is six dollars.',
    amendmentStatus: 'inserted',
  };
  chunks.push({
    ...chunks[0],
    id: makeChunkId(DOC, 'sec-1', 1),
    text: 'five dollars',
    amendmentStatus: 'deleted',
  });
  await backend.upsertChunks(DOC, chunks);
  // Persist the same span tree that ingest would have written.
  await registry.updateDocument(doc);
  await ask(
    DOC,
    { question: 'What is the fee?' },
    { backend, registry, provider },
  );
  const ordinary = messageText(requests()[0]!.messages[0]!.content);
  expect(ordinary).not.toMatch(/five dollars|\[struck\]|\[inserted\]/);
  const changed = await ask(
    DOC,
    { question: 'What changes to the fee?' },
    { backend, registry, provider },
  );
  const prompt = messageText(requests()[1]!.messages[0]!.content);
  expect(prompt).toContain('[struck]five dollars[/struck]');
  expect(prompt).toContain('[inserted]six dollars[/inserted]');
  expect(prompt).toContain('End of section.');
  expect(changed.answer.context).toBe('whole');
  expect(requests()[1]!.system).toContain(
    'Never quote struck text as what the law says or requires.',
  );
});

it('uses whole context for automatic and requested scenarios, including sections beyond the old cap', async () => {
  const scenarios = scenarioProvider(provider);
  const automatic = await ask(
    DOC,
    { question: 'How will this affect my family?' },
    { backend, registry, provider: scenarios, scenario: { enabled: true } },
  );
  expect(automatic.answer.scenario).toBeDefined();
  expect(scenarios.prompts[0]).toContain('section="sec-12"');
  const searched = vi.spyOn(backend, 'search');
  const requested = await runScenario(DOC, 'a librarian', {
    backend,
    registry,
    provider: scenarios,
  });
  expect(requested.status).toBe('ok');
  expect(scenarios.prompts.at(-1)).toContain('section="sec-12"');
  expect(searched).not.toHaveBeenCalled();
});

it('separates answer cache keys by mode', () => {
  const key = {
    docId: DOC,
    chipId: 'summary' as const,
    provider: 'anthropic',
    model: 'sonnet',
    endpoint: 'https://api.anthropic.com:443',
    promptVersion: 'v1',
  };
  expect(answerCacheKey({ ...key, context: 'whole' })).not.toBe(
    answerCacheKey({ ...key, context: 'excerpts' }),
  );
});

describe('whole effort override', () => {
  it('passes the configured effort', async () => {
    vi.stubEnv(envVar('EFFORT'), 'high');
    await ask(
      DOC,
      { question: 'Who can apply?' },
      { backend, registry, provider },
    );
    expect(requests()[0]?.effort).toBe('high');
  });
});
