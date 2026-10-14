import { constants } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  chmod,
  symlink,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND, envVar } from './brand.js';
import { AppError } from './model/index.js';
import { configFileSystem } from './config-files.js';
import {
  DEFAULT_MODELS,
  DEFAULT_RERANK_MODELS,
  getConfigDir,
  initConfig,
  pineconeConfig,
  providerConfig,
  redact,
  redactKey,
  resolveConfig,
  type ChoicePrompt,
  type ConfigOptions,
  type ConfigSettings,
  type SecretPrompt,
} from './config.js';

let home: string;
let options: ConfigOptions;
const secret = 'synthetic-secret-abcdef';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'config-test-'));
  options = { homeDir: home, env: {}, isTTY: false };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});
async function file(value: unknown, mode = 0o600): Promise<void> {
  await mkdir(getConfigDir(home), { recursive: true, mode: 0o700 });
  await chmod(getConfigDir(home), 0o700);
  const path = join(getConfigDir(home), 'config.json');
  await writeFile(path, JSON.stringify(value), { mode });
  await chmod(path, mode);
}
const mockEnv = { [envVar('LLM_PROVIDER')]: 'mock' };

it('uses BRAND for the config directory', () => {
  expect(getConfigDir(home)).toBe(join(home, BRAND.configDirName));
});

it('resolves defaults without keys for an explicitly selected mock', async () => {
  const config = await resolveConfig({ ...options, env: mockEnv });
  expect(config).toMatchObject({
    configDir: getConfigDir(home),
    backend: 'local',
    llmProvider: 'mock',
    maxDocs: 5,
    retrievalMode: 'hybrid_rerank',
    port: 4317,
    answerModel: DEFAULT_MODELS.mock.answer,
    extractModel: DEFAULT_MODELS.mock.extract,
  });
});

it.each([undefined, 'anthropic', 'openai', 'google'])(
  'store-only resolution keeps Pinecone settings without prompting for provider=%s',
  async (provider) => {
    const prompt = vi.fn();
    const choose = vi.fn();
    const config = await resolveConfig({
      ...options,
      env: {
        PINECONE_API_KEY: secret,
        ...(provider ? { [envVar('LLM_PROVIDER')]: provider } : {}),
        [envVar('MAX_DOCS')]: '9',
      },
      needsLlm: false,
      isTTY: true,
      prompt,
      choose,
    });
    expect(config).toMatchObject({
      backend: 'pinecone',
      pineconeApiKey: secret,
      maxDocs: 9,
      llmProvider: provider ?? 'anthropic',
      rerankModel: DEFAULT_RERANK_MODELS.pinecone,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  },
);

it('store-only resolution still prompts for a required Pinecone key', async () => {
  const prompt = vi.fn().mockResolvedValue(secret);
  const config = await resolveConfig({
    ...options,
    backend: 'pinecone',
    needsLlm: false,
    isTTY: true,
    prompt,
  });
  expect(config.pineconeApiKey).toBe(secret);
  expect(prompt).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      name: 'PINECONE_API_KEY',
      masked: true,
    }),
  );
});

it('resolves every environment setting before file values', async () => {
  await file({
    anthropicApiKey: 'file-anthropic',
    pineconeApiKey: 'file-pinecone',
    openaiApiKey: 'file-openai',
    googleApiKey: 'file-google',
    openaiBaseUrl: 'https://file.example/v1',
    llmProvider: 'anthropic',
    backend: 'local',
    maxDocs: 2,
    retrievalMode: 'dense',
    answerModel: 'file-answer',
    extractModel: 'file-extract',
    rerankModel: 'file-rerank',
    port: 4320,
  });
  const env = {
    PINECONE_API_KEY: 'env-pinecone',
    ANTHROPIC_API_KEY: 'env-anthropic',
    OPENAI_API_KEY: 'env-openai',
    GOOGLE_API_KEY: 'env-google',
    OPENAI_BASE_URL: 'http://localhost:1234/v1',
    [envVar('LLM_PROVIDER')]: 'openai',
    [envVar('BACKEND')]: 'pinecone',
    [envVar('MAX_DOCS')]: '7',
    [envVar('RETRIEVAL_MODE')]: 'sparse',
    [envVar('ANSWER_MODEL')]: 'env-answer',
    [envVar('EXTRACT_MODEL')]: 'env-extract',
    [envVar('RERANK_MODEL')]: 'env-rerank',
    [envVar('PORT')]: '5432',
  };
  expect(await resolveConfig({ ...options, env })).toMatchObject({
    pineconeApiKey: 'env-pinecone',
    anthropicApiKey: 'env-anthropic',
    openaiApiKey: 'env-openai',
    googleApiKey: 'env-google',
    openaiBaseUrl: 'http://localhost:1234/v1',
    llmProvider: 'openai',
    backend: 'pinecone',
    maxDocs: 7,
    retrievalMode: 'sparse',
    answerModel: 'env-answer',
    extractModel: 'env-extract',
    rerankModel: 'env-rerank',
    port: 5432,
  });
});

it('blank environment values fall through to file settings, without prompting', async () => {
  await file({ anthropicApiKey: secret, maxDocs: 3 });
  const prompt = vi.fn();
  expect(
    await resolveConfig({
      ...options,
      env: { ANTHROPIC_API_KEY: '  ' },
      isTTY: true,
      prompt,
    }),
  ).toMatchObject({
    anthropicApiKey: secret,
    llmProvider: 'anthropic',
    maxDocs: 3,
  });
  expect(prompt).not.toHaveBeenCalled();
});

it.each([
  [
    {
      ANTHROPIC_API_KEY: secret,
      OPENAI_API_KEY: secret,
      GOOGLE_API_KEY: secret,
    },
    'anthropic',
  ],
  [{ OPENAI_API_KEY: secret, GOOGLE_API_KEY: secret }, 'openai'],
  [{ GOOGLE_API_KEY: secret }, 'google'],
] as const)(
  'selects the first available API provider',
  async (env, provider) => {
    const config = await resolveConfig({ ...options, env });
    expect(config.llmProvider).toBe(provider);
    expect(config.answerModel).toBe(DEFAULT_MODELS[provider].answer);
  },
);

it('explicit provider and CLI backend override auto-selection and file/env backends', async () => {
  await file({
    backend: 'pinecone',
    pineconeApiKey: secret,
    llmProvider: 'anthropic',
    anthropicApiKey: secret,
  });
  const config = await resolveConfig({
    ...options,
    env: { ...mockEnv, [envVar('BACKEND')]: 'pinecone' },
    backend: 'local',
  });
  expect(config.backend).toBe('local');
  expect(config.llmProvider).toBe('mock');
});

it('auto-selects Pinecone when its key resolves from a file', async () => {
  await file({ pineconeApiKey: secret, llmProvider: 'mock' });
  expect((await resolveConfig(options)).backend).toBe('pinecone');
});

it('never auto-selects claude-cli, even on a TTY', async () => {
  const prompt = vi.fn();
  await expect(
    resolveConfig({ ...options, isTTY: true, prompt }),
  ).rejects.toMatchObject({ code: 'MISSING_KEY' });
  expect(prompt).not.toHaveBeenCalled();
});

it('explicit claude-cli needs no keys', async () => {
  const config = await resolveConfig({
    ...options,
    env: { [envVar('LLM_PROVIDER')]: 'claude-cli' },
  });
  expect(config.llmProvider).toBe('claude-cli');
});

it('missing provider lists the options, with claude-cli as an explicit local-dev choice', async () => {
  const prompt = vi.fn();
  const error: unknown = await resolveConfig({ ...options, prompt }).catch(
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({ code: 'MISSING_KEY' });
  const message = (error as AppError).userMessage;
  expect(message).toMatch(
    /ANTHROPIC_API_KEY.*OPENAI_API_KEY.*GOOGLE_API_KEY.*init/,
  );
  expect(message).toContain(
    `set ${envVar('LLM_PROVIDER')}=claude-cli to use your local Claude Code login (local dev only)`,
  );
  expect(prompt).not.toHaveBeenCalled();
});

it.each(['anthropic', 'openai', 'google'])(
  'requires the explicit %s provider key instead of selecting another provider',
  async (provider) => {
    await expect(
      resolveConfig({
        ...options,
        env: { [envVar('LLM_PROVIDER')]: provider, PINECONE_API_KEY: secret },
      }),
    ).rejects.toMatchObject({ code: 'MISSING_KEY' });
  },
);

it('TTY prompts only for missing required Pinecone and explicitly selected provider keys', async () => {
  const prompt = vi
    .fn<SecretPrompt>()
    .mockResolvedValueOnce('prompt-pinecone')
    .mockResolvedValueOnce('prompt-google');
  const config = await resolveConfig({
    ...options,
    env: {
      [envVar('BACKEND')]: 'pinecone',
      [envVar('LLM_PROVIDER')]: 'google',
    },
    isTTY: true,
    prompt,
  });
  expect(config).toMatchObject({
    backend: 'pinecone',
    pineconeApiKey: 'prompt-pinecone',
    googleApiKey: 'prompt-google',
  });
  expect(prompt.mock.calls.map(([request]) => request)).toEqual([
    expect.objectContaining({ name: 'PINECONE_API_KEY', masked: true }),
    expect.objectContaining({ name: 'GOOGLE_API_KEY', masked: true }),
  ]);
});

it("TTY asks once which provider, then only that provider's key", async () => {
  const prompt = vi.fn<SecretPrompt>().mockResolvedValue(secret);
  const choose = vi.fn<ChoicePrompt>().mockResolvedValue(' OpenAI ');
  const config = await resolveConfig({
    ...options,
    isTTY: true,
    prompt,
    choose,
  });
  expect(config).toMatchObject({ llmProvider: 'openai', openaiApiKey: secret });
  expect(choose).toHaveBeenCalledOnce();
  expect(prompt).toHaveBeenCalledOnce();
  expect(prompt.mock.calls[0]?.[0].name).toBe('OPENAI_API_KEY');
});

it.each([undefined, 'claude-cli', 'nonsense'])(
  'declining or invalid provider choice %s raises MISSING_KEY without prompting for keys',
  async (answer) => {
    const prompt = vi.fn();
    const choose = vi.fn<ChoicePrompt>().mockResolvedValue(answer);
    await expect(
      resolveConfig({ ...options, isTTY: true, prompt, choose }),
    ).rejects.toMatchObject({ code: 'MISSING_KEY' });
    expect(prompt).not.toHaveBeenCalled();
    await expect(stat(getConfigDir(home))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('a failing provider prompt raises a safe error', async () => {
  const choose = vi.fn<ChoicePrompt>().mockRejectedValue(new Error(secret));
  const error: unknown = await resolveConfig({
    ...options,
    isTTY: true,
    prompt: vi.fn(),
    choose,
  }).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: 'INVALID_INPUT', cause: undefined });
  expect(String(error)).not.toContain(secret);
});

it('missing Pinecone key fails in noninteractive mode', async () => {
  await expect(
    resolveConfig({ ...options, backend: 'pinecone', env: mockEnv }),
  ).rejects.toMatchObject({
    code: 'MISSING_KEY',
    message: expect.stringContaining('PINECONE_API_KEY') as unknown,
  });
});

it.each([0o640, 0o604, 0o644, 0o620])(
  'refuses an insecure config file (mode %s), warns, and falls back to env',
  async (mode) => {
    await file({ anthropicApiKey: secret }, mode);
    const warn = vi.fn();
    const config = await resolveConfig({ ...options, env: mockEnv, warn });
    expect(config.anthropicApiKey).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/Refusing.*permissions.*chmod 600/),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  },
);

it('uses a clear default warning for an insecure file', async () => {
  await file({ anthropicApiKey: secret }, 0o644);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await resolveConfig({ ...options, env: mockEnv });
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/Configuration warning: Refusing/),
  );
});

it('init writes 0600 config inside a 0700 directory, even when replacing permissive paths', async () => {
  await file({ llmProvider: 'google', googleApiKey: 'old-google' }, 0o644);
  await chmod(getConfigDir(home), 0o755);
  const prompt = vi
    .fn<SecretPrompt>()
    .mockResolvedValueOnce(secret)
    .mockResolvedValueOnce('anthropic-new')
    .mockResolvedValueOnce('openai-new')
    .mockResolvedValueOnce('google-new');
  const result = await initConfig({
    ...options,
    isTTY: true,
    prompt,
    warn: vi.fn(),
    force: true,
  });
  const path = join(getConfigDir(home), 'config.json');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(getConfigDir(home))).mode & 0o777).toBe(0o700);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    pineconeApiKey: secret,
    anthropicApiKey: 'anthropic-new',
    openaiApiKey: 'openai-new',
    googleApiKey: 'google-new',
  });
  expect(result.pineconeApiKey).toBe('…cdef');
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(prompt.mock.calls.map(([request]) => request.masked)).not.toContain(
    false,
  );
});

it('init preserves existing private settings and keys when entries are skipped', async () => {
  await file({ anthropicApiKey: secret, maxDocs: 8 });
  await initConfig({
    ...options,
    isTTY: true,
    prompt: vi.fn().mockResolvedValue(''),
  });
  expect(
    JSON.parse(await readFile(join(getConfigDir(home), 'config.json'), 'utf8')),
  ).toEqual({ anthropicApiKey: secret, maxDocs: 8 });
});

it('init refuses a group-readable config instead of dropping its keys, unless forced', async () => {
  await file({ openaiApiKey: 'keep-me-please' }, 0o644);
  const prompt = vi.fn().mockResolvedValue('new-key-value');
  const error: unknown = await initConfig({
    ...options,
    isTTY: true,
    prompt,
  }).catch((failure: unknown) => failure);
  expect(error).toMatchObject({
    code: 'INVALID_INPUT',
    userMessage: expect.stringMatching(/chmod 600.*--force/) as unknown,
  });
  expect(prompt).not.toHaveBeenCalled();
  expect(
    JSON.parse(await readFile(join(getConfigDir(home), 'config.json'), 'utf8')),
  ).toEqual({ openaiApiKey: 'keep-me-please' });
  await initConfig({
    ...options,
    isTTY: true,
    prompt: vi
      .fn()
      .mockResolvedValueOnce('new-key-value')
      .mockResolvedValue(''),
    force: true,
  });
  expect(
    JSON.parse(await readFile(join(getConfigDir(home), 'config.json'), 'utf8')),
  ).toEqual({ pineconeApiKey: 'new-key-value' });
});

it('init rejects noninteractive input without prompting or writing', async () => {
  const prompt = vi.fn();
  await expect(initConfig({ ...options, prompt })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(prompt).not.toHaveBeenCalled();
});

it('redact masks short keys fully and reveals at most the last 4 characters', () => {
  const config: ConfigSettings = {
    pineconeApiKey: secret,
    anthropicApiKey: 'abcd',
    openaiApiKey: '12345678',
    googleApiKey: secret,
    port: 1234,
  };
  expect(redact(config)).toEqual({
    pineconeApiKey: '…cdef',
    anthropicApiKey: '••••',
    openaiApiKey: '••••',
    googleApiKey: '…cdef',
    port: 1234,
  });
  expect(config.pineconeApiKey).toBe(secret);
});

it.each([
  ['sk-proj-abcdefghijklmnop1234', 'sk-…1234'],
  ['sk-ant-api03-abcdefghijkl9876', 'sk-ant-…9876'],
  ['pcsk_abcdefghijklmnop5555', 'pcsk_…5555'],
  ['AIzaSyAbcdefghijklmnopqr7777', '…7777'],
  ['sk-abcdefg', '…defg'],
  ['123456789', '…6789'],
])(
  'redactKey(%s) shows only a known public prefix and the last 4 characters',
  (key, expected) => {
    expect(redactKey(key)).toBe(expected);
  },
);

it.each(['anthropic', 'openai', 'google', 'claude-cli', 'mock'] as const)(
  'adapter options for %s contain only its own key',
  async (provider) => {
    const config = await resolveConfig({
      ...options,
      env: {
        [envVar('LLM_PROVIDER')]: provider,
        ANTHROPIC_API_KEY: 'a-own-key',
        OPENAI_API_KEY: 'o-own-key',
        GOOGLE_API_KEY: 'g-own-key',
        PINECONE_API_KEY: 'p-own-key',
        OPENAI_BASE_URL: 'https://endpoint.example/v1',
      },
    });
    const selected = providerConfig(config);
    expect(selected.apiKey).toBe(
      {
        anthropic: 'a-own-key',
        openai: 'o-own-key',
        google: 'g-own-key',
        'claude-cli': undefined,
        mock: undefined,
      }[provider],
    );
    expect(selected.baseURL).toBe(
      provider === 'openai' ? 'https://endpoint.example/v1' : undefined,
    );
    expect(providerConfig(config, 'extract').model).toBe(config.extractModel);
  },
);

describe('validation and secret-safe failures', () => {
  it.each([
    ['MAX_DOCS', '0'],
    ['MAX_DOCS', '-1'],
    ['MAX_DOCS', 'NaN'],
    ['MAX_DOCS', '1.5'],
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', 'abc'],
    ['BACKEND', secret],
    ['LLM_PROVIDER', secret],
    ['RETRIEVAL_MODE', secret],
  ])(
    'rejects invalid %s without disclosing its value',
    async (suffix, value) => {
      const error: unknown = await resolveConfig({
        ...options,
        env: { ...mockEnv, [envVar(suffix)]: value },
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'INVALID_INPUT', cause: undefined });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    },
  );
  it.each([
    'file:///tmp/api',
    'ftp://example.com',
    `https://user:${secret}@example.com`,
    `https://example.com?key=${secret}`,
    `https://example.com/#${secret}`,
  ])('rejects unsafe base URL without leaking it', async (url) => {
    await expect(
      resolveConfig({ ...options, env: { ...mockEnv, OPENAI_BASE_URL: url } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', cause: undefined });
  });
  it('invalid file schemas do not expose secrets or schema details', async () => {
    await file({ llmProvider: secret, unknownField: secret });
    await expect(resolveConfig(options)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      cause: undefined,
    });
  });
  it('invalid CLI backend is rejected', async () => {
    await expect(
      resolveConfig({ ...options, env: mockEnv, backend: secret }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Invalid backend. Choose pinecone or local.',
    });
  });
  it('prompt errors never retain unsafe messages or causes', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error(secret));
    const error: unknown = await initConfig({
      ...options,
      isTTY: true,
      prompt,
    }).catch((failure: unknown) => failure);
    expect(String(error)).not.toContain(secret);
    expect(error).toMatchObject({ code: 'INVALID_INPUT', cause: undefined });
  });
  it('successful config resolution and init never log keys', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await initConfig({
      ...options,
      isTTY: true,
      prompt: vi.fn().mockResolvedValue(secret),
    });
    await resolveConfig(options);
    for (const output of [log, info, warn, error])
      expect(output).not.toHaveBeenCalled();
  });
});

it('config refuses symlinks instead of following credentials to another file', async () => {
  await mkdir(getConfigDir(home));
  const target = join(home, 'target.json');
  await writeFile(target, JSON.stringify({ anthropicApiKey: secret }), {
    mode: 0o600,
  });
  await symlink(target, join(getConfigDir(home), 'config.json'));
  await expect(resolveConfig(options)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
});

it('warns when the config directory is group-readable or a symlink', async () => {
  await file({ anthropicApiKey: secret });
  await chmod(getConfigDir(home), 0o755);
  const warn = vi.fn();
  await resolveConfig({ ...options, env: mockEnv, warn });
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/0700/));
  const real = join(home, 'real-dir');
  const linked = await mkdtemp(join(tmpdir(), 'config-link-'));
  try {
    await mkdir(real, { mode: 0o700 });
    await writeFile(
      join(real, 'config.json'),
      JSON.stringify({ anthropicApiKey: secret }),
      { mode: 0o600 },
    );
    await symlink(real, join(linked, BRAND.configDirName));
    const symlinkWarn = vi.fn();
    await resolveConfig({
      ...options,
      homeDir: linked,
      env: mockEnv,
      warn: symlinkWarn,
    });
    expect(symlinkWarn).toHaveBeenCalledWith(
      expect.stringMatching(/symbolic link/),
    );
  } finally {
    await rm(linked, { recursive: true, force: true });
  }
});

it('write ignores directory fsync errors on platforms without it', async () => {
  const denied = Object.assign(new Error('x'), { code: 'EPERM' });
  const fs = {
    ...configFileSystem,
    open: ((path: string, flags: unknown, ...rest: unknown[]) =>
      flags === constants.O_RDONLY && path === getConfigDir(home)
        ? Promise.reject(denied)
        : (configFileSystem.open as (...args: unknown[]) => unknown)(
            path,
            flags,
            ...rest,
          )) as typeof configFileSystem.open,
  };
  await initConfig({
    ...options,
    fs,
    isTTY: true,
    prompt: vi.fn().mockResolvedValue(secret),
  });
  expect((await stat(join(getConfigDir(home), 'config.json'))).isFile()).toBe(
    true,
  );
  const other = {
    ...fs,
    open: (() =>
      Promise.reject(
        Object.assign(new Error('x'), { code: 'EIO' }),
      )) as typeof configFileSystem.open,
  };
  await expect(
    initConfig({
      ...options,
      fs: other,
      isTTY: true,
      prompt: vi.fn().mockResolvedValue(secret),
    }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

describe('Pinecone settings', () => {
  it('provides defaults and env/override precedence', () => {
    const defaults = pineconeConfig({}, {});
    expect(defaults).toMatchObject({
      cloud: 'aws',
      region: 'us-east-1',
      indexPrefix: BRAND.indexPrefix,
      rerankModel: DEFAULT_RERANK_MODELS.pinecone,
      upsertRetryBudgetMs: 600_000,
      queryRetryBudgetMs: 60_000,
      upsertBatchDelayMs: 0,
    });
    expect(
      pineconeConfig(
        { denseModel: 'override', upsertRetryBudgetMs: 10_000 },
        {
          [envVar('DENSE_MODEL')]: 'env-dense',
          [envVar('SPARSE_MODEL')]: 'env-sparse',
          [envVar('RERANK_MODEL')]: 'env-rerank',
          [envVar('PINECONE_REGION')]: 'eu-west-1',
          [envVar('PINECONE_UPSERT_RETRY_BUDGET_MS')]: '5000',
          [envVar('PINECONE_QUERY_RETRY_BUDGET_MS')]: '2000',
          [envVar('PINECONE_UPSERT_BATCH_DELAY_MS')]: '50',
        },
      ),
    ).toMatchObject({
      denseModel: 'override',
      sparseModel: 'env-sparse',
      rerankModel: 'env-rerank',
      region: 'eu-west-1',
      upsertRetryBudgetMs: 10_000,
      queryRetryBudgetMs: 2_000,
      upsertBatchDelayMs: 50,
    });
  });
  it.each([
    { indexPrefix: 'BAD-' },
    { indexPrefix: 'x'.repeat(45) + '-' },
    { timeoutMs: 0 },
    { upsertRetryBudgetMs: 0 },
    { queryRetryBudgetMs: -1 },
    { upsertBatchDelayMs: -1 },
  ])('rejects invalid settings without echoing values: %j', (settings) => {
    expect(() => pineconeConfig(settings, {})).toThrow(
      'Invalid Pinecone configuration.',
    );
  });
  it('rejects invalid pacing environment settings without echoing values', () => {
    expect(() =>
      pineconeConfig(
        {},
        { [envVar('PINECONE_UPSERT_BATCH_DELAY_MS')]: 'secret-key' },
      ),
    ).toThrow('Invalid Pinecone configuration.');
  });
});

it('explicit non-interactive init saves environment settings without prompting', async () => {
  const prompt = vi.fn();
  await initConfig({
    ...options,
    env: { [envVar('LLM_PROVIDER')]: 'mock' },
    nonInteractive: true,
    backend: 'local',
    prompt,
  });
  expect(prompt).not.toHaveBeenCalled();
  const saved: unknown = JSON.parse(
    await readFile(join(home, BRAND.configDirName, 'config.json'), 'utf8'),
  );
  expect(saved).toEqual({ llmProvider: 'mock', backend: 'local' });
  expect(
    (await stat(join(home, BRAND.configDirName, 'config.json'))).mode & 0o777,
  ).toBe(0o600);
});

it('non-interactive init rejects invalid environment settings before writing', async () => {
  await expect(
    initConfig({
      ...options,
      env: { [envVar('LLM_PROVIDER')]: 'invalid' },
      nonInteractive: true,
    }),
  ).rejects.toBeInstanceOf(AppError);
  await expect(
    stat(join(home, BRAND.configDirName, 'config.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('non-interactive init preserves existing settings, redacts saved keys and prefers an explicit backend', async () => {
  await file({ maxDocs: 3, anthropicApiKey: secret });
  const result = await initConfig({
    ...options,
    env: { [envVar('LLM_PROVIDER')]: 'mock', [envVar('BACKEND')]: 'pinecone' },
    nonInteractive: true,
    backend: 'local',
  });
  expect(result.backend).toBe('local');
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(
    JSON.parse(await readFile(join(getConfigDir(home), 'config.json'), 'utf8')),
  ).toEqual({
    maxDocs: 3,
    anthropicApiKey: secret,
    llmProvider: 'mock',
    backend: 'local',
  });
});

it('non-interactive init refuses unsafe existing config permissions without force', async () => {
  await file({ anthropicApiKey: secret }, 0o644);
  await expect(
    initConfig({ ...options, nonInteractive: true }),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(
    (await stat(join(getConfigDir(home), 'config.json'))).mode & 0o777,
  ).toBe(0o644);
});

it('non-interactive init rejects an invalid backend without writing', async () => {
  await expect(
    initConfig({ ...options, nonInteractive: true, backend: 'invalid' }),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
    userMessage: 'Invalid backend. Choose pinecone or local.',
  });
  await expect(
    stat(join(getConfigDir(home), 'config.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
