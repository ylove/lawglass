import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createRuntimeFrom } from './runtime.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'runtime-'));
});
afterEach(() => rm(home, { recursive: true, force: true }));

const sources = (env: Record<string, string>) => ({
  homeDir: home,
  env,
  isTTY: false,
});

test('builds the local backend and the configured providers', async () => {
  const runtime = await createRuntimeFrom(
    sources({ LEGSUM_LLM_PROVIDER: 'mock', LEGSUM_MAX_DOCS: '3' }),
  )({
    needsLlm: true,
  });
  expect(runtime.backend.kind).toBe('local');
  expect(runtime.maxDocs).toBe(3);
  expect(runtime.retrievalMode).toBe('hybrid_rerank');
  expect(runtime.answerProvider.id).toBe('mock');
  expect(runtime.extractProvider.id).toBe('mock');
});

test('commands without an LLM work before any key is configured', async () => {
  const runtime = await createRuntimeFrom(sources({}))({ needsLlm: false });
  expect(await runtime.registry.list()).toEqual([]);
  expect(() => runtime.answerProvider).toThrow(
    expect.objectContaining({ code: 'MISSING_KEY' }) as Error,
  );
  expect(() => runtime.extractProvider).toThrow(
    expect.objectContaining({ code: 'MISSING_KEY' }) as Error,
  );
});

test('commands that need an LLM fail with MISSING_KEY', async () => {
  await expect(
    createRuntimeFrom(sources({}))({ needsLlm: true }),
  ).rejects.toMatchObject({
    code: 'MISSING_KEY',
  });
});

test('other configuration errors are not swallowed', async () => {
  await expect(
    createRuntimeFrom(sources({}))({ needsLlm: false, backend: 'bogus' }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('the pinecone backend is reported as unavailable, without echoing the key', async () => {
  const error = await createRuntimeFrom(
    sources({
      LEGSUM_LLM_PROVIDER: 'mock',
      PINECONE_API_KEY: 'pcsk_secretsecretsecret',
    }),
  )({ needsLlm: true }).catch((e: unknown) => e);
  expect(error).toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  expect(JSON.stringify(error)).not.toContain('secretsecret');
  expect((error as Error).message).not.toContain('secretsecret');
});
