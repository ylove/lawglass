import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import { makeSectionedText } from '../../../tests/synth/index.js';
import { ingest } from '../pipeline/ingest.js';
import { Limits } from '../pipeline/limits.js';
import type { LlmProvider } from '../model/index.js';
import { cleanSentence, locate } from './index.js';

let env: PipelineEnv;
let docId: string;
let provider: LlmProvider;
beforeEach(async () => {
  env = await makePipelineEnv();
  const url = 'https://example.gov/gardens.txt';
  env.serve(url, makeSectionedText(), 'text/plain');
  docId = (
    await ingest(url, {
      backend: env.backend,
      provider: env.provider,
      registry: env.registry,
      fetcher: env.runtime.fetcher,
      now: env.runtime.now,
    })
  ).doc.docId;
  provider = {
    id: 'mock',
    model: 'locate-test',
    streamText: env.provider.streamText.bind(env.provider),
    generateObject: (req) =>
      Promise.resolve({
        object: req.schema.parse({ notFound: true, matches: [] }),
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});
const limits = () =>
  new Limits({
    maxConcurrentAsk: 1,
    maxConcurrentIngest: 1,
    maxCallsPerMinute: 1,
  });
it('cleans invisibles and enforces the raw cap and cleaned minimum', () => {
  expect(cleanSentence(' a\u200bbc ')).toBe('abc');
  for (const input of ['a\u200bb', '  ', 'a'.repeat(501)])
    expect(() => cleanSentence(input)).toThrow();
});
it('runs hybrid reranking including deleted text, one selection, and records usage', async () => {
  const search = vi.spyOn(env.backend, 'search');
  const rerank = vi.spyOn(env.backend, 'rerank');
  const generate = vi.spyOn(provider, 'generateObject');
  const touch = vi.spyOn(env.registry, 'touch');
  const result = await locate(docId, 'garden grants', {
    ...env,
    provider,
    limits: limits(),
  });
  expect(result.status).toBe('not-found');
  expect(generate).toHaveBeenCalledTimes(1);
  expect(rerank).toHaveBeenCalled();
  expect(
    search.mock.calls
      .slice(0, 2)
      .map(([r]) => r.index)
      .sort(),
  ).toEqual(['dense', 'sparse']);
  expect(search.mock.calls[0]![0].filter?.amendmentStatus).toBeUndefined();
  expect(touch).toHaveBeenCalledWith(
    docId,
    expect.objectContaining({ llmInputTokens: 5 }),
  );
});
it('queues behind the shared ask pool, releases it, and enforces the model ceiling', async () => {
  const budget = limits();
  const release = await budget.acquire('ask');
  const generate = vi.spyOn(provider, 'generateObject');
  const running = locate(docId, 'garden grants', {
    ...env,
    provider,
    limits: budget,
  });
  await vi.waitFor(() => {
    expect(budget.pool('ask').queued).toBe(1);
  });
  expect(generate).not.toHaveBeenCalled();
  release();
  await running;
  await expect(
    locate(docId, 'other grants', { ...env, provider, limits: budget }),
  ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(budget.pool('ask').inFlight).toBe(0);
});
it('invalid input costs no permit and a missing index releases its permit', async () => {
  const budget = limits(),
    acquire = vi.spyOn(budget, 'acquire');
  await expect(
    locate(docId, 'x', { ...env, provider, limits: budget }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(acquire).not.toHaveBeenCalled();
  await env.backend.deleteDocument(docId);
  await expect(
    locate(docId, 'garden grants', { ...env, provider, limits: budget }),
  ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
  expect(budget.pool('ask').inFlight).toBe(0);
});

it('selects source words through the complete retrieval path and validates the section citation', async () => {
  const generate = vi
    .spyOn(provider, 'generateObject')
    .mockImplementation((req) => {
      const passage = /<excerpt id="(\d+)" section="sec-2"/.exec(
        req.prompt,
      )?.[1];
      expect(passage).toBeDefined();
      return Promise.resolve({
        object: req.schema.parse({
          notFound: false,
          matches: [
            {
              passage: Number(passage),
              quote: 'award grants for shared gardens',
              explanation: 'The bill funds shared gardens [S:sec-2].',
            },
          ],
        }),
        usage: { inputTokens: 5, outputTokens: 5 },
      });
    });
  const result = await locate(docId, 'The bill funds shared gardens.', {
    ...env,
    provider,
    limits: limits(),
  });
  expect(result).toMatchObject({
    status: 'found',
    matches: [
      {
        sectionId: 'sec-2',
        label: 'in-bill',
        quote: [
          { text: 'award grants for shared gardens', status: 'unchanged' },
        ],
        citations: [{ sectionId: 'sec-2', valid: true }],
      },
    ],
  });
  expect(generate).toHaveBeenCalledTimes(1);
});
