import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { ingest } from '../core/pipeline/ingest.js';
import {
  LocateResponse,
  LocateVersionsResponse,
  type LlmProvider,
} from '../core/model/index.js';

let env: PipelineEnv, docId: string, provider: LlmProvider;
beforeEach(async () => {
  env = await makePipelineEnv();
  const url = 'https://example.gov/gardens.txt';
  env.serve(url, makeSectionedText(), 'text/plain');
  docId = (
    await ingest(url, {
      ...env,
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
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  };
  Object.assign(env.runtime, { answerProvider: provider });
});
afterEach(async () => {
  await env.cleanup();
});
const post = (app: Hono, body: unknown, id = docId, suffix = '') =>
  app.request(`/api/docs/${id}/locate${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
it('validates request schemas and cleaned input before calling the provider', async () => {
  const app = createApp(env.runtime),
    generate = vi.spyOn(provider, 'generateObject');
  for (const body of [
    {},
    { text: 1 },
    { text: 'a' },
    { text: 'a'.repeat(501) },
    { text: 'a\u200bb' },
  ])
    expect((await post(app, body)).status).toBe(400);
  expect(generate).not.toHaveBeenCalled();
  expect(
    (await post(app, { text: 'garden grants' }, 'f'.repeat(64))).status,
  ).toBe(404);
});
it('serves contract-valid responses and config outside public mode', async () => {
  const app = createApp(env.runtime);
  expect(
    LocateResponse.parse(
      await (await post(app, { text: 'garden grants' })).json(),
    ).status,
  ).toBe('not-found');
  expect(
    LocateVersionsResponse.parse(
      await (
        await post(app, { text: 'garden grants' }, docId, '/versions')
      ).json(),
    ).status,
  ).toBe('unavailable');
  expect(await (await app.request('/api/config')).json()).toMatchObject({
    locateEnabled: true,
  });
});
it('disables both endpoints in public mode with no model or version fetch', async () => {
  const app = createApp(env.runtime, { publicMode: true }),
    generate = vi.spyOn(provider, 'generateObject');
  const before = env.fetches.length;
  expect(
    LocateResponse.parse(
      await (await post(app, { text: 'garden grants' })).json(),
    ).status,
  ).toBe('disabled');
  expect(
    LocateVersionsResponse.parse(
      await (
        await post(app, { text: 'garden grants' }, docId, '/versions')
      ).json(),
    ).status,
  ).toBe('disabled');
  expect(generate).not.toHaveBeenCalled();
  expect(env.fetches).toHaveLength(before);
  expect(await (await app.request('/api/config')).json()).toMatchObject({
    locateEnabled: false,
  });
});
it('shares the question rate limiter and logs refusals without request text', async () => {
  const logs: string[] = [];
  const app = createApp(env.runtime, {
    limits: { questionsPerHour: 1 },
    logWriter: (line) => {
      logs.push(line);
    },
  });
  expect((await post(app, { text: 'garden grants' })).status).toBe(200);
  expect((await post(app, { text: 'secret pasted sentence' })).status).toBe(
    429,
  );
  expect(logs.join('')).toContain('RATE_LIMITED');
  expect(logs.join('')).not.toContain('secret pasted sentence');
});
