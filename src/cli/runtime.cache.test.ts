import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BRAND, envVar } from '../core/brand.js';
import type { SafeFetchOptions } from '../core/fetch/index.js';
import { createRuntimeFrom } from './runtime.js';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('../core/fetch/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/fetch/index.js')>()),
  safeFetch,
}));

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'runtime-cache-'));
  safeFetch.mockReset();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const sources = (env: Record<string, string>) => ({
  homeDir: home,
  env: { [envVar('LLM_PROVIDER')]: 'mock', ...env },
  isTTY: false,
});

test('the runtime fetcher defers cache writes, so ingest can cache only parsed documents', async () => {
  safeFetch.mockResolvedValue({});
  const runtime = await createRuntimeFrom(sources({}))({ needsLlm: false });
  await runtime.fetcher('https://example.gov/bill.xml', { refresh: true });
  const options = safeFetch.mock.calls[0]?.[1] as SafeFetchOptions;
  expect(options.deferCacheWrite).toBe(true);
  expect(options.cacheDir).toBe(join(home, BRAND.configDirName, 'cache'));
  expect(options.cacheBudgetBytes).toBe(500 * 1024 * 1024);
  expect(options.refresh).toBe(true);
});

test('the cache budget comes from the environment', async () => {
  safeFetch.mockResolvedValue({});
  const runtime = await createRuntimeFrom(
    sources({ [envVar('CACHE_MAX_MB')]: '64' }),
  )({ needsLlm: false });
  await runtime.fetcher('https://example.gov/bill.xml');
  expect(
    (safeFetch.mock.calls[0]?.[1] as SafeFetchOptions).cacheBudgetBytes,
  ).toBe(64 * 1024 * 1024);
});

test('a bad cache budget is rejected before any command runs', async () => {
  await expect(
    createRuntimeFrom(sources({ [envVar('CACHE_MAX_MB')]: 'lots' }))({
      needsLlm: false,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('clearFetchCache empties the configured cache directory only', async () => {
  const runtime = await createRuntimeFrom(sources({}))({ needsLlm: false });
  const cacheDir = join(home, BRAND.configDirName, 'cache');
  await mkdir(join(cacheDir, 'answers'), { recursive: true });
  await writeFile(join(cacheDir, 'a'.repeat(64)), 'bytes');
  await writeFile(join(cacheDir, `${'a'.repeat(64)}.json`), '{}');
  expect(await runtime.clearFetchCache()).toMatchObject({ snapshots: 1 });
  expect(await readdir(cacheDir)).toEqual(['answers']);
});

// C6: the answer cache key names the endpoint, never a key.
test('the answer endpoint identity names the default endpoint and strips secrets', async () => {
  const mock = await createRuntimeFrom(sources({}))({ needsLlm: false });
  expect(mock.answerEndpoint).toBe('mock:local');
  const hosted = await createRuntimeFrom({
    homeDir: home,
    env: {
      [envVar('LLM_PROVIDER')]: 'openai',
      OPENAI_API_KEY: 'sk-synthetic-endpoint-key',
    },
    isTTY: false,
  })({ needsLlm: false });
  expect(hosted.answerEndpoint).toBe('https://api.openai.com:443');
  const custom = await createRuntimeFrom({
    homeDir: home,
    env: {
      [envVar('LLM_PROVIDER')]: 'openai',
      OPENAI_API_KEY: 'sk-synthetic-endpoint-key',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    },
    isTTY: false,
  })({ needsLlm: false });
  expect(custom.answerEndpoint).toBe('http://localhost:11434');
  expect(custom.answerEndpoint).not.toContain('sk-');
});
