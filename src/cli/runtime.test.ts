import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pinecone } from '@pinecone-database/pinecone';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { describeBackendContract } from '../../tests/contracts/backend.contract.js';
import { fakePineconeClient } from '../../tests/contracts/fake-pinecone-client.js';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import { makeCongressionalBillXml } from '../../tests/synth/index.js';
import { BRAND, envVar } from '../core/brand.js';
import { initConfig, pineconeConfig } from '../core/config.js';
import * as fetchCore from '../core/fetch/index.js';
import { PineconeBackend } from '../core/index/index.js';
import { AppError } from '../core/model/index.js';
import { readParseLimits } from '../core/parse/limits.js';
import { ingest } from '../core/pipeline/index.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import { createProgram } from './program.js';
import { createPineconeClient, createRuntimeFrom } from './runtime.js';
import * as prompts from './secret-prompt.js';

let home: string;
const key = 'pcsk_synthetic_runtime_secret';
const mockEnv = { [envVar('LLM_PROVIDER')]: 'mock' };
const pineconeEnv = { ...mockEnv, PINECONE_API_KEY: key };
const logMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
let logCalls: unknown[][];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'runtime-'));
  logCalls = [];
  for (const method of logMethods)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const sources = (env: Record<string, string>) => ({
  homeDir: home,
  env,
  isTTY: false,
});

test('builds the local backend and the configured providers', async () => {
  const runtime = await createRuntimeFrom(
    sources({ ...mockEnv, [envVar('MAX_DOCS')]: '3' }),
  )({
    needsLlm: true,
  });
  expect(runtime.backend.kind).toBe('local');
  expect(runtime.maxDocs).toBe(3);
  expect(runtime.retrievalMode).toBe('hybrid_rerank');
  expect(runtime.answerProvider.id).toBe('mock');
  expect(runtime.extractProvider.id).toBe('mock');
});

test.each([false, true])(
  'forwards all ingest fetch options to safeFetch (publicMode=%s)',
  async (publicMode) => {
    const url = 'https://example.com/bill.xml';
    const bytes = makeCongressionalBillXml().bytes;
    const fetched = {
      bytes,
      docId: fetchCore.documentId(bytes),
      finalUrl: url,
      contentType: 'application/xml',
      format: 'xml' as const,
      fromCache: false,
    };
    const safeFetch = vi
      .spyOn(fetchCore, 'safeFetch')
      .mockResolvedValue(fetched);
    const runtime = await createRuntimeFrom(sources(mockEnv))({
      needsLlm: false,
    });
    const options = {
      signal: new AbortController().signal,
      validateUrl: vi.fn<(url: URL) => void>(),
      refresh: publicMode,
      parseLimits: readParseLimits(publicMode, {}),
    };

    await expect(runtime.fetcher(url, options)).resolves.toBe(fetched);
    expect(safeFetch).toHaveBeenCalledExactlyOnceWith(url, {
      cacheDir: join(home, BRAND.configDirName, 'cache'),
      ...options,
    });
    expect(safeFetch.mock.calls[0]?.[1]?.parseLimits).toBe(options.parseLimits);
  },
);

test('allows omitted fetch options so safeFetch uses its defaults', async () => {
  const safeFetch = vi
    .spyOn(fetchCore, 'safeFetch')
    .mockRejectedValue(new AppError('FETCH_FAILED'));
  const runtime = await createRuntimeFrom(sources(mockEnv))({
    needsLlm: false,
  });
  const url = 'https://example.com/bill.xml';

  await expect(runtime.fetcher(url)).rejects.toMatchObject({
    code: 'FETCH_FAILED',
  });
  expect(safeFetch).toHaveBeenCalledExactlyOnceWith(url, {
    cacheDir: join(home, BRAND.configDirName, 'cache'),
    signal: undefined,
    validateUrl: undefined,
    refresh: undefined,
    parseLimits: undefined,
  });
});

test('passes ingest parse limits through and preserves safeFetch failures before indexing', async () => {
  const failure = new AppError('TOO_LARGE');
  const safeFetch = vi.spyOn(fetchCore, 'safeFetch').mockRejectedValue(failure);
  const runtime = await createRuntimeFrom(sources(mockEnv))({
    needsLlm: false,
  });
  const backend = new MemoryBackend();
  const upsert = vi.spyOn(backend, 'upsertChunks');
  const provider = new ScriptedProvider();
  const parseLimits = { ...readParseLimits(true, {}), maxHtmlBytes: 1_024 };

  await expect(
    ingest('https://example.com/bill.html', {
      fetcher: runtime.fetcher,
      registry: runtime.registry,
      now: runtime.now,
      backend,
      provider,
      parseLimits,
    }),
  ).rejects.toBe(failure);
  expect(safeFetch).toHaveBeenCalledOnce();
  expect(safeFetch.mock.calls[0]?.[1]?.parseLimits).toBe(parseLimits);
  expect(upsert).not.toHaveBeenCalled();
  expect(provider.calls).toEqual([]);
  expect(await runtime.registry.list()).toEqual([]);
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

function expectNoKeyInLogs(): void {
  expect(JSON.stringify(logCalls)).not.toContain(key);
}

test.each([undefined, 'pinecone'])(
  'selects Pinecone from a resolved key with backend=%s',
  async (backend) => {
    const sdk = fakePineconeClient();
    const factory = vi.fn(() => sdk.client);
    const runtime = await createRuntimeFrom({
      ...sources(pineconeEnv),
      createPineconeClient: factory,
    })({ needsLlm: true, backend });
    expect(runtime.backend).toBeInstanceOf(PineconeBackend);
    expect(factory).toHaveBeenCalledExactlyOnceWith(key);
    expect(sdk.create).not.toHaveBeenCalled();
    await runtime.backend.ensureReady();
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(runtime.answerProvider.id).toBe('mock');
    expectNoKeyInLogs();
  },
);

test('explicit local overrides a Pinecone key without creating a client', async () => {
  const factory = vi.fn(() => fakePineconeClient().client);
  const runtime = await createRuntimeFrom({
    ...sources(pineconeEnv),
    createPineconeClient: factory,
  })({ backend: 'local', needsLlm: true });
  expect(runtime.backend.kind).toBe('local');
  expect(factory).not.toHaveBeenCalled();
});

test('uses the private config key, with environment taking precedence', async () => {
  await initConfig({
    ...sources(pineconeEnv),
    nonInteractive: true,
  });
  const factory = vi.fn(() => fakePineconeClient().client);
  await createRuntimeFrom({
    ...sources({}),
    createPineconeClient: factory,
  })({ needsLlm: true });
  expect(factory).toHaveBeenLastCalledWith(key);
  await createRuntimeFrom({
    ...sources({ PINECONE_API_KEY: 'synthetic-env-key' }),
    createPineconeClient: factory,
  })({ needsLlm: true });
  expect(factory).toHaveBeenLastCalledWith('synthetic-env-key');
  expectNoKeyInLogs();
});

test('uses the existing masked Pinecone key prompt', async () => {
  const prompt = vi.spyOn(prompts, 'promptSecret').mockResolvedValue(key);
  const factory = vi.fn(() => fakePineconeClient().client);
  await createRuntimeFrom({
    ...sources(mockEnv),
    isTTY: true,
    createPineconeClient: factory,
  })({ backend: 'pinecone', needsLlm: true });
  expect(prompt).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'PINECONE_API_KEY',
      masked: true,
    }),
  );
  expect(factory).toHaveBeenCalledExactlyOnceWith(key);
  expectNoKeyInLogs();
});

test.each([true, false])(
  'missing Pinecone key fails with MISSING_KEY (needsLlm=%s)',
  async (needsLlm) => {
    const factory = vi.fn(() => fakePineconeClient().client);
    await expect(
      createRuntimeFrom({
        ...sources(mockEnv),
        createPineconeClient: factory,
      })({ backend: 'pinecone', needsLlm }),
    ).rejects.toMatchObject({
      code: 'MISSING_KEY',
      userMessage: expect.stringContaining('PINECONE_API_KEY') as string,
    });
    expect(factory).not.toHaveBeenCalled();
  },
);

test('Pinecone works without LLM credentials and retains other resolved settings', async () => {
  const runtime = await createRuntimeFrom({
    ...sources({
      PINECONE_API_KEY: key,
      [envVar('LLM_PROVIDER')]: 'openai',
      [envVar('MAX_DOCS')]: '7',
      [envVar('PORT')]: '4321',
      [envVar('RETRIEVAL_MODE')]: 'sparse',
    }),
    createPineconeClient: () => fakePineconeClient().client,
  })({ needsLlm: false });
  expect(runtime.backend.kind).toBe('pinecone');
  expect(runtime.maxDocs).toBe(7);
  expect(runtime.port).toBe(4321);
  expect(runtime.retrievalMode).toBe('sparse');
  expect(() => runtime.answerProvider).toThrow(
    expect.objectContaining({ code: 'MISSING_KEY' }) as Error,
  );
  expect(() => runtime.extractProvider).toThrow(
    expect.objectContaining({ code: 'MISSING_KEY' }) as Error,
  );
});

test('passes Pinecone env settings and the resolved file reranker to the adapter', async () => {
  await initConfig({
    ...sources({ ...pineconeEnv, [envVar('RERANK_MODEL')]: 'file-reranker' }),
    nonInteractive: true,
  });
  const env = {
    [envVar('PINECONE_CLOUD')]: 'gcp',
    [envVar('PINECONE_REGION')]: 'us-central1',
    [envVar('DENSE_MODEL')]: 'test-dense',
    [envVar('SPARSE_MODEL')]: 'test-sparse',
  };
  const settings = pineconeConfig({ rerankModel: 'file-reranker' }, env);
  const sdk = fakePineconeClient(settings);
  const runtime = await createRuntimeFrom({
    ...sources(env),
    createPineconeClient: () => sdk.client,
  })({ needsLlm: true });
  expect((runtime.backend as PineconeBackend).config).toEqual(settings);
  await runtime.backend.ensureReady();
  expect(sdk.create).toHaveBeenCalledWith(
    expect.objectContaining({
      cloud: 'gcp',
      region: 'us-central1',
      embed: { model: 'test-dense', fieldMap: { text: 'embed_text' } },
    }),
  );
});

test('rejects invalid Pinecone settings before constructing the SDK', async () => {
  const factory = vi.fn(() => fakePineconeClient().client);
  await expect(
    createRuntimeFrom({
      ...sources({ ...pineconeEnv, [envVar('PINECONE_CLOUD')]: key }),
      createPineconeClient: factory,
    })({ needsLlm: true }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT', cause: undefined });
  expect(factory).not.toHaveBeenCalled();
  expectNoKeyInLogs();
});

test.each([
  new Error(`SDK error with ${key}`),
  new AppError('MISSING_KEY', key, { userMessage: key, cause: new Error(key) }),
])(
  'sanitizes client construction errors without retaining credentials',
  async (failure) => {
    const error: unknown = await createRuntimeFrom({
      ...sources(pineconeEnv),
      createPineconeClient: () => {
        throw failure;
      },
    })({ needsLlm: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      cause: undefined,
    });
    expect((error as AppError).message).not.toContain(key);
    expect((error as AppError).userMessage).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
    expectNoKeyInLogs();
  },
);

test.each([
  [401, 'MISSING_KEY'],
  [429, 'RATE_LIMITED'],
  [500, 'BACKEND_UNAVAILABLE'],
])('SDK request failure %s never exposes credentials', async (status, code) => {
  const sdk = fakePineconeClient();
  sdk.create.mockRejectedValue(
    Object.assign(new Error(`SDK request with ${key}`), { status }),
  );
  const runtime = await createRuntimeFrom({
    ...sources(pineconeEnv),
    createPineconeClient: () => sdk.client,
  })({ needsLlm: true });
  const error: unknown = await runtime.backend
    .ensureReady()
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ code, cause: undefined });
  expect((error as AppError).message).not.toContain(key);
  expect((error as AppError).userMessage).not.toContain(key);
  expect(JSON.stringify(error)).not.toContain(key);
  expectNoKeyInLogs();
});

test('the real SDK factory clears both debug variables and uses its resolved key', () => {
  vi.stubEnv('PINECONE_DEBUG', '1');
  vi.stubEnv('PINECONE_DEBUG_CURL', '1');
  vi.stubEnv('PINECONE_API_KEY', 'synthetic-unresolved-key');
  const client = createPineconeClient(key);
  expect(client).toBeInstanceOf(Pinecone);
  expect((client as Pinecone).getConfig()).toEqual({
    apiKey: key,
    maxRetries: 0,
  });
  expect(process.env.PINECONE_DEBUG).toBeUndefined();
  expect(process.env.PINECONE_DEBUG_CURL).toBeUndefined();
  expectNoKeyInLogs();
});

test.each(['PINECONE_DEBUG', 'PINECONE_DEBUG_CURL'])(
  'production path: %s=1 with a 401 that echoes the key logs nothing',
  async (variable) => {
    vi.stubEnv(variable, '1');
    let requests = 0;
    const transport: typeof fetch = () => {
      requests++;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: `bad key ${key}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const runtime = await createRuntimeFrom({
      ...sources(pineconeEnv),
      createPineconeClient: (apiKey) => createPineconeClient(apiKey, transport),
    })({ needsLlm: true });
    const error: unknown = await runtime.backend
      .ensureReady()
      .catch((e: unknown) => e);
    expect(requests, 'the real SDK sent the request').toBeGreaterThan(0);
    expect(error).toMatchObject({ code: 'MISSING_KEY' });
    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(key);
    expect(logged).not.toContain('<<< Body');
    expect(logged).not.toContain('>>> ');
  },
);

test.each(['remove', 'server delete'])(
  'ingest, ask, serve, list and %s use Pinecone across fresh runtimes',
  async (removal) => {
    const sdk = fakePineconeClient();
    const factory = vi.fn(() => sdk.client);
    const file = join(home, 'bill.xml');
    await writeFile(file, makeCongressionalBillXml().bytes);
    let output = '';
    const run = async (args: string[], needsProvider = true) => {
      await createProgram({
        runtime: createRuntimeFrom({
          ...sources(needsProvider ? pineconeEnv : { PINECONE_API_KEY: key }),
          createPineconeClient: factory,
        }),
        write: (text) => {
          output += text;
        },
        serve: async (runtime) => {
          const app = createApp(runtime, { localOnly: false });
          expect(await (await app.request('/api/config')).json()).toMatchObject(
            { backend: 'pinecone' },
          );
          if (removal === 'server delete') {
            const [doc] = await runtime.registry.list();
            const response = await app.request(`/api/docs/${doc!.docId}`, {
              method: 'DELETE',
            });
            expect(response.status).toBe(204);
          }
        },
      }).parseAsync(args, { from: 'user' });
    };
    await run(['ingest', file, '--name', 'bill', '--backend', 'pinecone']);
    expect(output).toContain('Ingested: bill');
    await run(['ask', 'bill', 'What are the grants?', '--backend', 'pinecone']);
    expect(output).toContain('Citations:');
    expect(sdk.dense.search).toHaveBeenCalled();
    expect(sdk.rerank).toHaveBeenCalled();
    const callsBeforeList = sdk.create.mock.calls.length;
    await run(['list', '--backend', 'pinecone'], false);
    expect(output).toContain('bill  |');
    expect(sdk.create).toHaveBeenCalledTimes(callsBeforeList);
    if (removal === 'remove') {
      await run(['serve', '--backend', 'pinecone']);
      await run(['remove', 'bill', '--backend', 'pinecone'], false);
      expect(output).toContain('Removed bill');
    } else {
      await run(['serve', '--backend', 'pinecone']);
    }
    expect(sdk.dense.deleteNamespace).toHaveBeenCalled();
    expect(sdk.sparse.deleteNamespace).toHaveBeenCalled();
    const runtime = await createRuntimeFrom({
      ...sources({ PINECONE_API_KEY: key }),
      createPineconeClient: factory,
    })({ needsLlm: false });
    expect(await runtime.registry.list()).toEqual([]);
    expect(output).not.toContain(key);
    expectNoKeyInLogs();
  },
);

describeBackendContract('Pinecone through CLI runtime (fake SDK)', async () => {
  const contractHome = await mkdtemp(join(tmpdir(), 'runtime-contract-'));
  const sdk = fakePineconeClient();
  const runtime = await createRuntimeFrom({
    env: { PINECONE_API_KEY: key },
    homeDir: contractHome,
    isTTY: false,
    createPineconeClient: () => sdk.client,
  })({ needsLlm: false });
  return {
    backend: runtime.backend,
    cleanup: () => rm(contractHome, { recursive: true, force: true }),
  };
});

test.each(['claude-cli', 'mock'])(
  'hosted mode refuses %s without prompting',
  async (provider) => {
    const prompt = vi.spyOn(prompts, 'promptSecret');
    const choose = vi.spyOn(prompts, 'promptChoice');
    await expect(
      createRuntimeFrom({
        ...sources({ [envVar('LLM_PROVIDER')]: provider }),
        isTTY: true,
      })({ needsLlm: true, hostedMode: true }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      userMessage: expect.stringContaining(provider) as string,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  },
);
test('the hosted provider guard reads saved configuration, with an explicit e2e mock escape hatch', async () => {
  await initConfig({ homeDir: home, env: mockEnv, nonInteractive: true });
  await expect(
    createRuntimeFrom(sources({}))({ needsLlm: true, hostedMode: true }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const runtime = await createRuntimeFrom(
    sources({ [envVar('ALLOW_MOCK')]: '1' }),
  )({ needsLlm: true, hostedMode: true });
  expect(runtime.answerProvider.id).toBe('mock');
  await expect(
    createRuntimeFrom(
      sources({
        [envVar('LLM_PROVIDER')]: 'claude-cli',
        [envVar('ALLOW_MOCK')]: '1',
      }),
    )({ needsLlm: true, hostedMode: true }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
test('hosted configuration with missing credentials does not prompt', async () => {
  const prompt = vi.spyOn(prompts, 'promptSecret');
  const choose = vi.spyOn(prompts, 'promptChoice');
  await expect(
    createRuntimeFrom({ ...sources({}), isTTY: true })({
      needsLlm: true,
      hostedMode: true,
    }),
  ).rejects.toMatchObject({ code: 'MISSING_KEY' });
  expect(prompt).not.toHaveBeenCalled();
  expect(choose).not.toHaveBeenCalled();
});
