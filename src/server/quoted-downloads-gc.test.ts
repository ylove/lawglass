/**
 * A kept download must not keep the HTML parse tree alive (it measured ~32x the page's bytes).
 * The real `safeFetch` is used because the leak was in its `commitCache` closure, which a fake
 * result without one never exercised.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { safeFetch } from '../core/fetch/index.js';
import type { NormalizedDoc } from '../core/model/index.js';
import { makePipelineEnv } from '../../tests/support/pipeline-env.js';
import { createApp } from './app.js';
import { QuotedDownloads } from './quotes.js';

let agent: MockAgent;
let dir: string;
const origin = 'https://example.gov';
beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  dir = await mkdtemp(join(tmpdir(), 'quoted-gc-'));
});
afterEach(async () => {
  await agent.close();
  await rm(dir, { recursive: true, force: true });
});

/** Fetches and stores a page; nothing but the store (and the WeakRef) outlives the call. */
async function keepPage(store: QuotedDownloads): Promise<WeakRef<object>> {
  agent
    .get(origin)
    .intercept({ path: '/bill' })
    .reply(
      200,
      `<html><body>${'<p>Section text.</p>'.repeat(200)}</body></html>`,
      {
        headers: { 'content-type': 'text/html' },
      },
    );
  const fetched = await safeFetch(`${origin}/bill`, {
    cacheDir: dir,
    resolver: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
    dispatcherFactory: () => agent,
    deferCacheWrite: true,
    skipWrapperCheck: true,
  });
  const dom = fetched.preparedHtml?.dom;
  if (!dom || !fetched.commitCache)
    throw new Error('expected a network HTML fetch');
  const ref = new WeakRef(dom);
  store.put('alice', `${origin}/bill`, {
    doc: {
      sections: [],
      definitions: [],
      externalRefs: [],
    } as unknown as NormalizedDoc,
    fetched,
    attachment: undefined,
    publicFacts: {} as never,
    estimates: {},
  });
  return ref;
}

test('a stored HTML download, commitCache included, lets the parse tree be collected', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const store = new QuotedDownloads();
  const ref = await keepPage(store);
  // The entry is still held, with its way to commit to the cache.
  expect(
    store.get('alice', `${origin}/bill`)?.fetched.commitCache,
  ).toBeDefined();
  for (let i = 0; i < 5 && ref.deref(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    gc();
  }
  expect(ref.deref()).toBeUndefined();
});

test('a route paused inside the host admission holds no parse tree either', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const env = await makePipelineEnv();
  const refs: WeakRef<object>[] = [];
  const page = `<html><body>${Array.from(
    { length: 40 },
    (_, i) =>
      `<h2>Section ${String(i + 1)}. Title</h2><p>The department shall act.</p>`,
  ).join('')}</body></html>`;
  agent
    .get('https://govinfo.gov')
    .intercept({ path: '/bill.htm' })
    .reply(200, page, { headers: { 'content-type': 'text/html' } });
  env.runtime.fetcher = async (u, o) => {
    const result = await safeFetch(u, {
      ...o,
      cacheDir: dir,
      resolver: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      dispatcherFactory: () => agent,
      deferCacheWrite: true,
    });
    if (result.preparedHtml) refs.push(new WeakRef(result.preparedHtml.dom));
    return result;
  };
  let holdAdmission!: () => void;
  const held = new Promise<void>((resolve) => {
    holdAdmission = resolve;
  });
  let reached!: () => void;
  const inHook = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const app = createApp(env.runtime, {
    auth: {
      middleware: async (_c, next) => next(),
      readerId: () => 'alice',
    },
    backgroundScope: () => Promise.resolve(undefined),
    admission: async () => {
      reached();
      await held;
      return {
        allow: false,
        status: 402,
        quote: { quoteId: 'q', display: '$' },
      };
    },
    logWriter: () => undefined,
    quote: {
      prices: {
        deterministic: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
      },
    },
  });
  const response = app.request('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://govinfo.gov/bill.htm' }),
  });
  await inHook;
  expect(refs).toHaveLength(1);
  for (let i = 0; i < 5 && refs[0]?.deref(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    gc();
  }
  // The request is still inside the admission, yet nothing keeps the parse tree.
  expect(refs[0]?.deref()).toBeUndefined();
  holdAdmission();
  expect((await response).status).toBe(402);
  await env.cleanup();
});
