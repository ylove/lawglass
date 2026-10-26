import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { scriptedObjects } from '../../tests/support/picture-provider.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { envVar } from '../core/brand.js';
import { IngestEvent, PicturesResponse } from '../core/model/index.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import type { AppOptions } from './app.js';

const URL_A = 'https://example.gov/gardens.txt';
let env: PipelineEnv;

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(URL_A, makeSectionedText(), 'text/plain');
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1000');
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '0');
  resetSharedLimits();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  vi.unstubAllEnvs();
  resetSharedLimits();
  await env.cleanup();
});

const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, { localOnly: false, summaryWaitMs: 20, ...options });

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

describe('GET /api/docs/:docId/{summary,breakdown}/pictures', () => {
  test('an unknown document is a 404, like every other document route', async () => {
    for (const source of ['summary', 'breakdown'])
      expect(
        (await app().request(`/api/docs/${'c'.repeat(64)}/${source}/pictures`))
          .status,
      ).toBe(404);
  });

  test('a known document answers with the pictures contract; behaviour is in pictures.test.ts', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    // Swapped in after ingest, so the ingest's own metadata call keeps the default provider.
    const extract = scriptedObjects([{ pictures: [] }]);
    Object.defineProperty(env.runtime, 'extractProvider', {
      get: () => extract,
      configurable: true,
    });
    for (const source of ['summary', 'breakdown']) {
      const res = await a.request(`/api/docs/${docId}/${source}/pictures`);
      expect(res.status).toBe(200);
      expect(PicturesResponse.safeParse(await res.json()).success).toBe(true);
      const head = await a.request(`/api/docs/${docId}/${source}/pictures`, {
        method: 'HEAD',
      });
      expect(head.status).toBe(200);
    }
  });
});
