/**
 * Wires real dependencies for the CLI: config, registry, backend, providers and the SSRF-safe
 * fetcher. Commands receive a `CliRuntime`, so tests inject fakes instead of touching any of this.
 */
import { LocalBackend } from '../core/index/index.js';
import {
  getConfigDir,
  providerConfig,
  resolveConfig,
  type RuntimeConfig,
} from '../core/config.js';
import { defaultCacheDir, safeFetch } from '../core/fetch/index.js';
import { createProvider } from '../core/llm/index.js';
import {
  AppError,
  isAppError,
  type LlmProvider,
  type RetrievalBackend,
  type RetrievalMode,
} from '../core/model/index.js';
import type { ChipRunner, Fetcher, PdfParser } from '../core/pipeline/index.js';
import { Registry } from '../core/registry.js';
import { promptChoice, promptSecret } from './secret-prompt.js';

export interface CliRuntime {
  backend: RetrievalBackend;
  registry: Registry;
  fetcher: Fetcher;
  now: () => Date;
  maxDocs: number;
  retrievalMode: RetrievalMode;
  port: number;
  /** Throws MISSING_KEY when no provider is configured (commands that need no LLM never touch it). */
  readonly answerProvider: LlmProvider;
  readonly extractProvider: LlmProvider;
  chips?: ChipRunner | undefined;
  parsePdf?: PdfParser | undefined;
}

export interface RuntimeOptions {
  backend?: string | undefined;
  /** False for list/remove: they must work before any API key is configured. */
  needsLlm: boolean;
}

export type RuntimeFactory = (options: RuntimeOptions) => Promise<CliRuntime>;

function buildBackend(kind: string, configDir: string): RetrievalBackend {
  if (kind === 'local') return new LocalBackend({ configDir });
  // TODO: the Pinecone adapter is not on main yet.
  throw new AppError(
    'BACKEND_UNAVAILABLE',
    'The pinecone backend is not available yet.',
    {
      userMessage:
        'The Pinecone backend is not available yet. Use --backend local.',
    },
  );
}

/** Config sources, injectable so tests never read the real home directory or environment. */
export interface RuntimeSources {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  isTTY?: boolean;
}

export const createRuntimeFrom =
  (sources: RuntimeSources = {}): RuntimeFactory =>
  async (options) => {
    let config: RuntimeConfig | undefined;
    try {
      config = await resolveConfig({
        ...sources,
        ...(options.backend === undefined ? {} : { backend: options.backend }),
        prompt: promptSecret,
        choose: promptChoice,
      });
    } catch (error) {
      // list/remove only need the store; a missing key must not block them.
      if (
        options.needsLlm ||
        !isAppError(error) ||
        error.code !== 'MISSING_KEY'
      )
        throw error;
    }
    const configDir = config?.configDir ?? getConfigDir(sources.homeDir);
    const missing = (): never => {
      throw new AppError('MISSING_KEY');
    };
    const cacheDir = defaultCacheDir(configDir);
    return {
      backend: buildBackend(
        config?.backend ?? options.backend ?? 'local',
        configDir,
      ),
      registry: new Registry(configDir),
      fetcher: (url, options) =>
        safeFetch(url, { cacheDir, signal: options?.signal }),
      now: () => new Date(),
      maxDocs: config?.maxDocs ?? 5,
      retrievalMode: config?.retrievalMode ?? 'hybrid_rerank',
      port: config?.port ?? 4317,
      get answerProvider() {
        return config
          ? createProvider(providerConfig(config, 'answer'))
          : missing();
      },
      get extractProvider() {
        return config
          ? createProvider(providerConfig(config, 'extract'))
          : missing();
      },
    };
  };

export const createRuntime: RuntimeFactory = createRuntimeFrom();
