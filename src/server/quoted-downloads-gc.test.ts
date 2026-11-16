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
