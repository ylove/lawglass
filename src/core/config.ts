import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import { BRAND, envVar } from './brand.js';
import { AppError, type BackendKind, type ProviderConfig, type ProviderId } from './model/index.js';
import {
  configFileSystem, readPrivateJson, storageError, writePrivateJson,
  type ConfigFileSystem,
} from './config-files.js';

const Backend = z.enum(['pinecone', 'local']);
const Provider = z.enum(['anthropic', 'openai', 'google', 'claude-cli', 'mock']);
const nonempty = z.string().trim().min(1);
const ApiKey = nonempty;
const BaseUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});

/** File settings use camelCase. Missing settings fall through to selection and defaults. */
export const ConfigSettings = z.object({
  pineconeApiKey: ApiKey.optional(),
  anthropicApiKey: ApiKey.optional(),
  openaiApiKey: ApiKey.optional(),
  googleApiKey: ApiKey.optional(),
  openaiBaseUrl: BaseUrl.optional(),
  llmProvider: Provider.optional(),
  backend: Backend.optional(),
  maxDocs: z.number().int().positive().optional(),
  retrievalMode: z.enum(['dense', 'sparse', 'hybrid', 'hybrid_rerank']).optional(),
  answerModel: nonempty.optional(),
  extractModel: nonempty.optional(),
  rerankModel: nonempty.optional(),
  port: z.number().int().min(1).max(65535).optional(),
}).strict();
export type ConfigSettings = z.infer<typeof ConfigSettings>;

export const DEFAULT_MODELS: Record<ProviderId, { answer: string; extract: string }> = {
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
export type SecretPrompt = (request: SecretPromptRequest) => Promise<string | undefined>;
export interface ConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  fs?: ConfigFileSystem;
  isTTY?: boolean;
  prompt?: SecretPrompt;
  warn?: (message: string) => void;
  note?: (message: string) => void;
  hasClaude?: () => boolean | Promise<boolean>;
  /** The caller passes the parsed --backend value here. */
  backend?: string;
}

export function getConfigDir(homeDir: string = homedir()): string {
  return join(homeDir, BRAND.configDirName);
}

function validateSettings(value: unknown): ConfigSettings {
  const parsed = ConfigSettings.safeParse(value);
  if (!parsed.success) throw storageError('Invalid configuration. Check the provider, backend, keys, models, URL, and numeric settings.');
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
  anthropic: 'anthropicApiKey', openai: 'openaiApiKey', google: 'googleApiKey',
} as const;

function environmentSettings(env: NonNullable<ConfigOptions['env']>): ConfigSettings {
  const mapping: Record<keyof ConfigSettings, string> = {
    ...keyNames, openaiBaseUrl: 'OPENAI_BASE_URL', llmProvider: envVar('LLM_PROVIDER'),
    backend: envVar('BACKEND'), maxDocs: envVar('MAX_DOCS'), retrievalMode: envVar('RETRIEVAL_MODE'),
    answerModel: envVar('ANSWER_MODEL'), extractModel: envVar('EXTRACT_MODEL'),
    rerankModel: envVar('RERANK_MODEL'), port: envVar('PORT'),
  };
  const values: Record<string, unknown> = {};
  for (const [field, name] of Object.entries(mapping)) {
    const value = env[name]?.trim();
    if (value) values[field] = field === 'maxDocs' || field === 'port' ? Number(value) : value;
  }
  return validateSettings(values);
}

export async function hasClaudeOnPath(
  env: NonNullable<ConfigOptions['env']> = process.env,
  fs: ConfigFileSystem = configFileSystem,
): Promise<boolean> {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      await fs.access(path, constants.X_OK);
      if ((await fs.stat(path)).isFile()) return true;
    } catch {
      // A missing or non-executable candidate is not a configured provider.
    }
  }
  return false;
}

function missingKey(name?: string): AppError {
  const message = name
    ? `Set ${name} in the environment, run ${BRAND.name} init, or enter it in an interactive terminal.`
    : `Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY; run ${BRAND.name} init; or install Claude Code for local development. You can also explicitly select claude-cli or mock with ${envVar('LLM_PROVIDER')}.`;
  return new AppError('MISSING_KEY', message, { userMessage: message });
}

async function promptKey(field: KeyField, options: ConfigOptions): Promise<string | undefined> {
  if (!(options.isTTY ?? process.stdin.isTTY) || !options.prompt) return undefined;
  let value;
  try {
    value = await options.prompt({ name: keyNames[field], message: `${keyNames[field]} (leave blank to skip): `, masked: true });
  } catch {
    throw storageError('The key prompt was cancelled or could not be completed.');
  }
  if (!value?.trim()) return undefined;
  return validateSettings({ [field]: value })[field];
}

async function readSettings(options: ConfigOptions): Promise<ConfigSettings> {
  const value = await readPrivateJson(join(getConfigDir(options.homeDir), 'config.json'), options.fs ?? configFileSystem,
    options.warn ?? ((message) => { console.warn(`Configuration warning: ${message}`); }));
  return value === undefined ? {} : validateSettings(value);
}

export async function resolveConfig(options: ConfigOptions = {}): Promise<RuntimeConfig> {
  const env = options.env ?? process.env;
  const settings = { ...await readSettings(options), ...environmentSettings(env) };
  if (options.backend !== undefined) {
    const parsed = Backend.safeParse(options.backend);
    if (!parsed.success) throw storageError('Invalid backend. Choose pinecone or local.');
    settings.backend = parsed.data;
  }
  const backend = settings.backend ?? (settings.pineconeApiKey ? 'pinecone' : 'local');
  if (backend === 'pinecone' && !settings.pineconeApiKey) {
    settings.pineconeApiKey = await promptKey('pineconeApiKey', options);
    if (!settings.pineconeApiKey) throw missingKey('PINECONE_API_KEY');
  }
  let provider = settings.llmProvider;
  if (!provider) {
    for (const id of ['anthropic', 'openai', 'google'] as const) {
      if (settings[providerKeys[id]]) { provider = id; break; }
    }
    if (!provider && await (options.hasClaude?.() ?? hasClaudeOnPath(env, options.fs))) {
      provider = 'claude-cli';
      (options.note ?? console.info)('Using your local Claude Code login through claude-cli. This provider is meant for local development.');
    }
    if (!provider) {
      for (const id of ['anthropic', 'openai', 'google'] as const) {
        const field = providerKeys[id];
        settings[field] = await promptKey(field, options);
        if (settings[field]) { provider = id; break; }
      }
    }
  }
  if (!provider) throw missingKey();
  if (provider in providerKeys) {
    const field = providerKeys[provider as keyof typeof providerKeys];
    settings[field] ??= await promptKey(field, options);
    if (!settings[field]) throw missingKey(keyNames[field]);
  }
  return {
    ...settings, configDir: getConfigDir(options.homeDir), backend, llmProvider: provider,
    maxDocs: settings.maxDocs ?? 5, retrievalMode: settings.retrievalMode ?? 'hybrid_rerank',
    port: settings.port ?? 4317, answerModel: settings.answerModel ?? DEFAULT_MODELS[provider].answer,
    extractModel: settings.extractModel ?? DEFAULT_MODELS[provider].extract,
    rerankModel: settings.rerankModel ?? DEFAULT_RERANK_MODELS[backend],
  };
}

/** Construct adapter options with only that provider's own credential. */
export function providerConfig(config: RuntimeConfig, purpose: 'answer' | 'extract' = 'answer'): ProviderConfig {
  const provider = config.llmProvider;
  const apiKey = provider in providerKeys ? config[providerKeys[provider as keyof typeof providerKeys]] : undefined;
  return {
    provider, model: purpose === 'answer' ? config.answerModel : config.extractModel,
    ...(apiKey ? { apiKey } : {}),
    ...(provider === 'openai' && config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
  };
}

/** Short keys are fully masked so display never reveals a complete credential. */
export function redact<T extends ConfigSettings>(config: T): T {
  const result = { ...config };
  for (const field of Object.keys(keyNames) as KeyField[]) {
    const key = result[field];
    if (key) result[field] = key.length > 4 ? `sk-…${key.slice(-4)}` : 'sk-…';
  }
  return result;
}

export async function initConfig(options: ConfigOptions = {}): Promise<ConfigSettings> {
  if (!(options.isTTY ?? process.stdin.isTTY) || !options.prompt) {
    throw storageError('Run init in an interactive terminal to enter masked keys.');
  }
  const settings = await readSettings(options);
  for (const field of Object.keys(keyNames) as KeyField[]) {
    const key = await promptKey(field, options);
    if (key) settings[field] = key;
  }
  const validated = validateSettings(settings);
  await writePrivateJson(join(getConfigDir(options.homeDir), 'config.json'), validated, options.fs ?? configFileSystem);
  return redact(validated);
}
