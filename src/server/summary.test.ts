import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { scenarioProvider } from '../../tests/support/scenario-provider.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { IngestEvent, SummaryResponse } from '../core/model/index.js';
import type {
  AnswerResult,
  LlmProvider,
  ObjectRequest,
  TextRequest,
} from '../core/model/index.js';
import { defaultChipRunner } from '../core/pipeline/ask.js';
import type { ChipRunner } from '../core/pipeline/index.js';
import { readSseEvents } from '../web/sse.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import type { AppOptions } from './app.js';
import { FAILED_RETRY_MS, SUMMARY_CACHE_VERSION } from './summary.js';
import { AnswerCache } from '../core/answer-cache.js';
import { SUMMARY_PROMPT_VERSION } from '../core/chip-summary.js';

const URL_A = 'https://example.gov/gardens.txt';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(URL_A, makeSectionedText(), 'text/plain');
});
afterEach(async () => {
  await env.cleanup();
});

/** Counts every model call and can hold them back until `release()`. */
function countingProvider(base: LlmProvider) {
  let open: () => void = () => undefined;
  let gate: Promise<void> | undefined;
  const state = {
    calls: 0,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
      gate = undefined;
    },
  };
  const provider: LlmProvider = {
    id: base.id,
    model: base.model,
    streamText: async function* (req: TextRequest) {
      state.calls++;
      await gate;
      yield* base.streamText(req);
    },
    generateObject: async <T>(req: ObjectRequest<T>) => {
      state.calls++;
      await gate;
      return base.generateObject(req);
    },
  };
  return Object.assign(provider, { state });
}

const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, { localOnly: false, ...options });

async function ingestDoc(a: Hono): Promise<string> {
  const res = await a.request('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: URL_A }),
  });
  for await (const e of readSseEvents(res, IngestEvent))
    if (e.type === 'done') return e.doc.docId;
  throw new Error('ingest did not finish');
}

async function summary(a: Hono, docId: string): Promise<SummaryResponse> {
  const res = await a.request(`/api/docs/${docId}/summary`);
  expect(res.status).toBe(200);
  return SummaryResponse.parse(await res.json());
}

const settled = (a: Hono, docId: string) =>
  vi.waitFor(
    async () => {
      const result = await summary(a, docId);
      expect(result.status).not.toBe('pending');
      return result;
    },
    { timeout: 5000 },
  );

describe('GET /api/docs/:docId/summary', () => {
  test('a miss starts the summary once and answers pending; the next poll is the cached answer', async () => {
    const provider = countingProvider(env.provider);
    Object.assign(env.runtime, { answerProvider: provider });
    const a = app();
    const docId = await ingestDoc(a);
    expect(await summary(a, docId)).toEqual({ status: 'pending' });
    const done = await vi.waitFor(
      async () => {
        const r = await summary(a, docId);
        expect(r.status).toBe('cached');
        return r;
      },
      { timeout: 5000 },
    );
    expect(done.answer?.text).toBeTruthy();
    expect(done.answer?.declined).toBe(false);
    expect(provider.state.calls).toBeGreaterThan(0);
  });

  test('a second open, even from a fresh server, makes zero model calls', async () => {
    const provider = countingProvider(env.provider);
    Object.assign(env.runtime, { answerProvider: provider });
    const first = app();
    const docId = await ingestDoc(first);
    await summary(first, docId);
    const cached = await vi.waitFor(async () => {
      const r = await summary(first, docId);
      expect(r.status).toBe('cached');
      return r;
    });
    const calls = provider.state.calls;
    // A new app instance has no memory of the first one: only the disk cache can answer.
    const second = app();
    expect(await summary(second, docId)).toEqual(cached);
    expect(await summary(first, docId)).toEqual(cached);
    expect(provider.state.calls).toBe(calls);
    // The file is private: it holds answers derived from the user's document.
    const dir = join(env.registry.configDir, 'cache', 'answers', docId);
    expect(await readdir(dir)).toHaveLength(1);
  });

  test('concurrent requests share one run', async () => {
    const provider = countingProvider(env.provider);
    // One chip run per start: count runs instead of model calls.
    const chips = vi.fn<ChipRunner>((chipId, docId, ctx, opts) => {
      provider.state.calls++;
      return defaultChipRunner(chipId, docId, ctx, opts);
    });
    Object.assign(env.runtime, { answerProvider: env.provider, chips });
    const a = app();
    const docId = await ingestDoc(a);
    const [x, y, z] = await Promise.all([
      summary(a, docId),
      summary(a, docId),
      Promise.resolve(app().request(`/api/docs/${docId}/summary`)).then((r) =>
        r.json(),
      ),
    ]);
    expect([x.status, y.status, (z as SummaryResponse).status]).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    await settled(a, docId);
    expect(chips).toHaveBeenCalledTimes(1);
  });

  test('a single-subject bill caches its scenario with the summary', async () => {
    const provider = scenarioProvider(env.provider);
    Object.assign(env.runtime, { answerProvider: provider });
    const a = app();
    const docId = await ingestDoc(a);
    await summary(a, docId);
    const done = await settled(a, docId);
    expect(done.status).toBe('cached');
    expect(provider.scenarioCalls).toBe(1);
    expect(done.answer?.scenario?.frames.length).toBeGreaterThanOrEqual(3);
    // And the cached copy keeps it, with no second scenario call.
    expect((await summary(a, docId)).answer?.scenario).toBeDefined();
    expect(provider.scenarioCalls).toBe(1);
  });

  test('the cache key covers the scenario prompt: a changed version is a miss', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    await summary(a, docId);
    await settled(a, docId);
    const cache = new AnswerCache({
      dir: join(env.registry.configDir, 'cache', 'answers'),
    });
    const key = {
      docId,
      chipId: 'summary' as const,
      provider: env.provider.id,
      model: env.provider.model,
    };
    expect(SUMMARY_CACHE_VERSION).not.toBe(SUMMARY_PROMPT_VERSION);
    expect(
      await cache.get({ ...key, promptVersion: SUMMARY_CACHE_VERSION }),
    ).toBeDefined();
    expect(
      await cache.get({
        ...key,
        promptVersion: `${SUMMARY_PROMPT_VERSION}.changed`,
      }),
    ).toBeUndefined();
  });

  test('an unknown document is a 404', async () => {
    const res = await app().request(`/api/docs/${'0'.repeat(64)}/summary`);
    expect(res.status).toBe(404);
  });

  test('a declined answer is never cached and is not retried on every poll', async () => {
    let now = Date.UTC(2026, 9, 14);
    const declined: AnswerResult = {
      text: 'x',
      citations: [],
      declined: true,
      warnings: [],
      provider: env.provider.id,
      model: env.provider.model,
      usage: { inputTokens: 1, outputTokens: 1 },
    } as unknown as AnswerResult;
    const chips = vi.fn<ChipRunner>(() =>
      Promise.resolve({
        answer: declined,
        hits: [],
        backendUsage: {
          embedTokens: 0,
          rerankUnits: 0,
          readUnits: 0,
          writeUnits: 0,
        },
      }),
    );
    Object.assign(env.runtime, { chips });
    const a = app({ now: () => now });
    const docId = await ingestDoc(a);
    expect(await summary(a, docId)).toEqual({ status: 'pending' });
    await vi.waitFor(async () => {
      expect(chips).toHaveBeenCalledTimes(1);
      expect(await summary(a, docId)).toEqual({ status: 'disabled' });
    });
    // Polling inside the cool-down never reaches the model again.
    for (let i = 0; i < 3; i++) await summary(a, docId);
    expect(chips).toHaveBeenCalledTimes(1);
    // After it, one new attempt is allowed.
    now += FAILED_RETRY_MS + 1;
    expect(await summary(a, docId)).toEqual({ status: 'pending' });
    await vi.waitFor(() => {
      expect(chips).toHaveBeenCalledTimes(2);
    });
    // Let the second run finish before the temp directory is removed.
    await vi.waitFor(async () => {
      expect(await summary(a, docId)).toEqual({ status: 'disabled' });
    });
    const dir = join(env.registry.configDir, 'cache', 'answers', docId);
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a provider failure is not cached and does not escape as an error', async () => {
    const chips = vi.fn<ChipRunner>(() => Promise.reject(new Error('boom')));
    Object.assign(env.runtime, { chips });
    const a = app();
    const docId = await ingestDoc(a);
    expect((await summary(a, docId)).status).toBe('pending');
    await vi.waitFor(async () => {
      expect((await summary(a, docId)).status).toBe('disabled');
    });
  });

  test('a document removed mid-run gets no cached answer', async () => {
    const provider = countingProvider(env.provider);
    Object.assign(env.runtime, { answerProvider: provider });
    const a = app();
    const docId = await ingestDoc(a);
    provider.state.hold();
    await summary(a, docId);
    await vi.waitFor(() => {
      expect(provider.state.calls).toBeGreaterThan(0);
    });
    expect(
      (await a.request(`/api/docs/${docId}`, { method: 'DELETE' })).status,
    ).toBe(204);
    provider.state.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dir = join(env.registry.configDir, 'cache', 'answers', docId);
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an unconfigured provider is reported to the owner', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    Object.defineProperty(env.runtime, 'answerProvider', {
      get: () => {
        throw new Error('no key');
      },
      configurable: true,
    });
    const res = await a.request(`/api/docs/${docId}/summary`);
    expect(res.status).toBe(500);
  });
});

describe('public mode', () => {
  test('a miss is disabled and never starts a model call', async () => {
    const provider = countingProvider(env.provider);
    Object.assign(env.runtime, { answerProvider: provider });
    const owner = app();
    const docId = await ingestDoc(owner);
    const pub = app({ publicMode: true });
    for (let i = 0; i < 3; i++)
      expect(await summary(pub, docId)).toEqual({ status: 'disabled' });
    expect(provider.state.calls).toBe(0);
  });

  test('serves a summary the owner already generated', async () => {
    const owner = app();
    const docId = await ingestDoc(owner);
    await summary(owner, docId);
    const done = await settled(owner, docId);
    const pub = app({ publicMode: true });
    expect(await summary(pub, docId)).toEqual(done);
  });

  test('is never rate limited or bot-checked, because it cannot spend anything', async () => {
    const owner = app();
    const docId = await ingestDoc(owner);
    const pub = app({ publicMode: true, limits: { questionsPerHour: 1 } });
    for (let i = 0; i < 5; i++)
      expect((await pub.request(`/api/docs/${docId}/summary`)).status).toBe(
        200,
      );
  });

  test('an unconfigured provider is just disabled for visitors', async () => {
    const owner = app();
    const docId = await ingestDoc(owner);
    Object.defineProperty(env.runtime, 'answerProvider', {
      get: () => {
        throw new Error('no key');
      },
      configurable: true,
    });
    expect(await summary(app({ publicMode: true }), docId)).toEqual({
      status: 'disabled',
    });
  });
});
