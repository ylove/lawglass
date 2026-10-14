import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BRAND, envVar } from './brand.js';
import {
  AppError,
  type BackendKind,
  type ProviderConfig,
  type ProviderId,
} from './model/index.js';
import {
  configFileSystem,
  readPrivateJson,
  storageError,
  writePrivateJson,
  type ConfigFileSystem,
} from './config-files.js';

const Backend = z.enum(['pinecone', 'local']);
const Provider = z.enum([
  'anthropic',
  'openai',
  'google',
  'claude-cli',
  'mock',
]);
const nonempty = z.string().trim().min(1);
const ApiKey = nonempty;
const BaseUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});

/** File settings use camelCase. Missing settings fall through to selection and defaults. */
export const ConfigSettings = z
  .object({
    pineconeApiKey: ApiKey.optional(),
    anthropicApiKey: ApiKey.optional(),
    openaiApiKey: ApiKey.optional(),
    googleApiKey: ApiKey.optional(),
    openaiBaseUrl: BaseUrl.optional(),
    llmProvider: Provider.optional(),
    backend: Backend.optional(),
    maxDocs: z.number().int().positive().optional(),
    retrievalMode: z
      .enum(['dense', 'sparse', 'hybrid', 'hybrid_rerank'])
      .optional(),
    answerModel: nonempty.optional(),
    extractModel: nonempty.optional(),
    rerankModel: nonempty.optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();
export type ConfigSettings = z.infer<typeof ConfigSettings>;

export const DEFAULT_MODELS: Record<
  ProviderId,
  { answer: string; extract: string }
> = {
  anthropic: { answer: 'claude-sonnet-5-5', extract: 'claude-haiku-5-5' },
  openai: { answer: 'gpt-4.1', extract: 'gpt-4.1-mini' },
  google: { answer: 'gemini-2.5-flash', extract: 'gemini-2.5-flash' },
  'claude-cli': { answer: 'sonnet', extract: 'haiku' },
  mock: { answer: 'mock', extract: 'mock' },
};
export const DEFAULT_RERANK_MODELS = {
  pinecone: 'bge-reranker-v2-m3',
  local: 'Xenova/ms-marco-MiniLM-L-6-v2',
} as const;

export interface RuntimeConfig extends ConfigSettings {
  configDir: string;
  backend: BackendKind;
  llmProvider: ProviderId;
  maxDocs: number;
  retrievalMode: NonNullable<ConfigSettings['retrievalMode']>;
  answerModel: string;
  extractModel: string;
  rerankModel: string;
  port: number;
}

export interface SecretPromptRequest {
  name: string;
  message: string;
  masked: true;
}
export interface ChoicePromptRequest {
  message: string;
  choices: readonly string[];
}
export type ChoicePrompt = (
  request: ChoicePromptRequest,
) => Promise<string | undefined>;
export type SecretPrompt = (
  request: SecretPromptRequest,
) => Promise<string | undefined>;
export interface ConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  fs?: ConfigFileSystem;
  isTTY?: boolean;
  prompt?: SecretPrompt;
  warn?: (message: string) => void;
  /** Asks which provider to use when none is configured. Returns undefined to skip. */
  choose?: ChoicePrompt;
  /** init only: replace an unreadable (group/world-readable) config instead of refusing. */
  force?: boolean;
  /** The caller passes the parsed --backend value here. */
  backend?: string;
}

export function getConfigDir(homeDir: string = homedir()): string {
  return join(homeDir, BRAND.configDirName);
}

function validateSettings(value: unknown): ConfigSettings {
  const parsed = ConfigSettings.safeParse(value);
  if (!parsed.success)
    throw storageError(
      'Invalid configuration. Check the provider, backend, keys, models, URL, and numeric settings.',
    );
  return parsed.data;
}

const keyNames = {
  pineconeApiKey: 'PINECONE_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  googleApiKey: 'GOOGLE_API_KEY',
} as const;
type KeyField = keyof typeof keyNames;
const providerKeys = {
  anthropic: 'anthropicApiKey',
  openai: 'openaiApiKey',
  google: 'googleApiKey',
} as const;

function environmentSettings(
  env: NonNullable<ConfigOptions['env']>,
): ConfigSettings {
  const mapping: Record<keyof ConfigSettings, string> = {
    ...keyNames,
    openaiBaseUrl: 'OPENAI_BASE_URL',
    llmProvider: envVar('LLM_PROVIDER'),
    backend: envVar('BACKEND'),
    maxDocs: envVar('MAX_DOCS'),
    retrievalMode: envVar('RETRIEVAL_MODE'),
    answerModel: envVar('ANSWER_MODEL'),
    extractModel: envVar('EXTRACT_MODEL'),
    rerankModel: envVar('RERANK_MODEL'),
    port: envVar('PORT'),
  };
  const values: Record<string, unknown> = {};
  for (const [field, name] of Object.entries(mapping)) {
    const value = env[name]?.trim();
    if (value)
      values[field] =
        field === 'maxDocs' || field === 'port' ? Number(value) : value;
  }
  return validateSettings(values);
}

function missingKey(name?: string): AppError {
  const message = name
    ? `Set ${name} in the environment, run ${BRAND.name} init, or enter it in an interactive terminal.`
    : `No LLM provider is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY; run ${BRAND.name} init; or set ${envVar('LLM_PROVIDER')}=claude-cli to use your local Claude Code login (local dev only).`;
  return new AppError('MISSING_KEY', message, { userMessage: message });
}

async function promptKey(
  field: KeyField,
  options: ConfigOptions,
): Promise<string | undefined> {
  if (!(options.isTTY ?? process.stdin.isTTY) || !options.prompt)
    return undefined;
  let value;
  try {
    value = await options.prompt({
      name: keyNames[field],
      message: `${keyNames[field]} (leave blank to skip): `,
      masked: true,
    });
  } catch {
    throw storageError(
      'The key prompt was cancelled or could not be completed.',
    );
  }
  if (!value?.trim()) return undefined;
  return validateSettings({ [field]: value })[field];
}

const choosableProviders = ['anthropic', 'openai', 'google'] as const;

/** Ask once which provider to use; the caller then prompts for only that provider's key. */
async function chooseProvider(
  choose: ChoicePrompt,
): Promise<ProviderId | undefined> {
  let answer;
  try {
    answer = await choose({
      message: 'Which LLM provider do you want to use?',
      choices: choosableProviders,
    });
  } catch {
    throw storageError(
      'The provider prompt was cancelled or could not be completed.',
    );
  }
  const normalized = answer?.trim().toLowerCase();
  return choosableProviders.find((id) => id === normalized);
}

async function readSettings(
  options: ConfigOptions,
  warn: (message: string) => void = options.warn ??
    ((message) => {
      console.warn(`Configuration warning: ${message}`);
    }),
): Promise<ConfigSettings> {
  const value = await readPrivateJson(
    join(getConfigDir(options.homeDir), 'config.json'),
    options.fs ?? configFileSystem,
    warn,
  );
  return value === undefined ? {} : validateSettings(value);
}

export async function resolveConfig(
  options: ConfigOptions = {},
): Promise<RuntimeConfig> {
  const env = options.env ?? process.env;
  const settings = {
    ...(await readSettings(options)),
    ...environmentSettings(env),
  };
  if (options.backend !== undefined) {
    const parsed = Backend.safeParse(options.backend);
    if (!parsed.success)
      throw storageError('Invalid backend. Choose pinecone or local.');
    settings.backend = parsed.data;
  }
  const backend =
    settings.backend ?? (settings.pineconeApiKey ? 'pinecone' : 'local');
  if (backend === 'pinecone' && !settings.pineconeApiKey) {
    settings.pineconeApiKey = await promptKey('pineconeApiKey', options);
    if (!settings.pineconeApiKey) throw missingKey('PINECONE_API_KEY');
  }
  let provider = settings.llmProvider;
  if (!provider) {
    for (const id of ['anthropic', 'openai', 'google'] as const) {
      if (settings[providerKeys[id]]) {
        provider = id;
        break;
      }
    }
    // claude-cli is opt-in: it is never chosen just because the binary exists.
    if (!provider && (options.isTTY ?? process.stdin.isTTY) && options.choose) {
      provider = await chooseProvider(options.choose);
    }
  }
  if (!provider) throw missingKey();
  if (provider in providerKeys) {
    const field = providerKeys[provider as keyof typeof providerKeys];
    settings[field] ??= await promptKey(field, options);
    if (!settings[field]) throw missingKey(keyNames[field]);
  }
  return {
    ...settings,
    configDir: getConfigDir(options.homeDir),
    backend,
    llmProvider: provider,
    maxDocs: settings.maxDocs ?? 5,
    retrievalMode: settings.retrievalMode ?? 'hybrid_rerank',
    port: settings.port ?? 4317,
    answerModel: settings.answerModel ?? DEFAULT_MODELS[provider].answer,
    extractModel: settings.extractModel ?? DEFAULT_MODELS[provider].extract,
    rerankModel: settings.rerankModel ?? DEFAULT_RERANK_MODELS[backend],
  };
}

/** Construct adapter options with only that provider's own credential. */
export function providerConfig(
  config: RuntimeConfig,
  purpose: 'answer' | 'extract' = 'answer',
): ProviderConfig {
  const provider = config.llmProvider;
  const apiKey =
    provider in providerKeys
      ? config[providerKeys[provider as keyof typeof providerKeys]]
      : undefined;
  return {
    provider,
    model: purpose === 'answer' ? config.answerModel : config.extractModel,
    ...(apiKey ? { apiKey } : {}),
    ...(provider === 'openai' && config.openaiBaseUrl
      ? { baseURL: config.openaiBaseUrl }
      : {}),
  };
}

// Only prefixes that are public knowledge are echoed; anything else could leak key structure.
const PUBLIC_KEY_PREFIXES = ['sk-ant-', 'sk-', 'pcsk_'] as const;

/** Show at most the last 4 characters. Keys of 8 characters or fewer are masked entirely. */
export function redactKey(key: string): string {
  if (key.length <= 8) return '••••';
  const prefix = PUBLIC_KEY_PREFIXES.find(
    (candidate) =>
      key.startsWith(candidate) && key.length >= candidate.length + 8,
  );
  return `${prefix ?? ''}…${key.slice(-4)}`;
}

export function redact<T extends ConfigSettings>(config: T): T {
  const result = { ...config };
  for (const field of Object.keys(keyNames) as KeyField[]) {
    const key = result[field];
    if (key) result[field] = redactKey(key);
  }
  return result;
}

export async function initConfig(
  options: ConfigOptions = {},
): Promise<ConfigSettings> {
  if (!(options.isTTY ?? process.stdin.isTTY) || !options.prompt) {
    throw storageError(
      'Run init in an interactive terminal to enter masked keys.',
    );
  }
  // An unreadable config is refused, not dropped: starting from {} would silently delete its keys.
  const settings = await readSettings(options, (message) => {
    if (message.startsWith('Refusing')) {
      if (options.force) return; // The user chose to replace it.
      throw storageError(
        `${message} Fix its permissions (chmod 600), or pass --force to replace it and discard its contents.`,
      );
    }
    (
      options.warn ??
      ((text) => {
        console.warn(`Configuration warning: ${text}`);
      })
    )(message);
  });
  for (const field of Object.keys(keyNames) as KeyField[]) {
    const key = await promptKey(field, options);
    if (key) settings[field] = key;
  }
  const validated = validateSettings(settings);
  await writePrivateJson(
    join(getConfigDir(options.homeDir), 'config.json'),
    validated,
    options.fs ?? configFileSystem,
  );
  return redact(validated);
}

/** Pinecone integrated-embedding settings. Index lifecycle only: the document cap lives in the shared registry. */
export const PineconeSettings = z.object({
  denseModel: nonempty.default('llama-text-embed-v2'),
  sparseModel: nonempty.default('pinecone-sparse-english-v0'),
  rerankModel: nonempty.default(DEFAULT_RERANK_MODELS.pinecone),
  cloud: z.enum(['aws', 'gcp', 'azure']).default('aws'),
  // Starter plans only serve AWS us-east-1.
  region: nonempty.default('us-east-1'),
  indexPrefix: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*-$/)
    .max(39)
    .default(BRAND.indexPrefix),
  pollIntervalMs: z.number().int().positive().default(1_000),
  timeoutMs: z.number().int().positive().default(120_000),
});
export type PineconeSettings = z.infer<typeof PineconeSettings>;

/** Defaults, then env (`envVar(...)`), then explicit overrides. */
export function pineconeConfig(
  overrides: Partial<PineconeSettings> = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): PineconeSettings {
  const fromEnv = {
    denseModel: env[envVar('DENSE_MODEL')],
    sparseModel: env[envVar('SPARSE_MODEL')],
    rerankModel: env[envVar('RERANK_MODEL')],
    cloud: env[envVar('PINECONE_CLOUD')],
    region: env[envVar('PINECONE_REGION')],
  };
  const parsed = PineconeSettings.safeParse({
    ...Object.fromEntries(
      Object.entries(fromEnv).filter(([, value]) => value?.trim()),
    ),
    ...overrides,
  });
  if (!parsed.success)
    throw new AppError('INVALID_INPUT', 'Invalid Pinecone configuration.');
  return parsed.data;
}
