/**
 * Wires real dependencies for the CLI: config, registry, backend, providers and the SSRF-safe
 * fetcher. Commands receive a `CliRuntime`, so tests inject fakes instead of touching any of this.
 */
import { Pinecone } from '@pinecone-database/pinecone';
import {
  LocalBackend,
  disableSdkDiagnostics,
  PineconeBackend,
  type PineconeClient,
} from '../core/index/index.js';
import {
  pineconeConfig,
  providerConfig,
  resolveConfig,
  type RuntimeConfig,
} from '../core/config.js';
import { defaultCacheDir, safeFetch } from '../core/fetch/index.js';
import { createProvider } from '../core/llm/index.js';
import {
  AppError,
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
  /** False for list/remove and retrieval-only eval: only the backend key is required. */
  needsLlm: boolean;
}

export type RuntimeFactory = (options: RuntimeOptions) => Promise<CliRuntime>;

export function createPineconeClient(
  apiKey: string,
  /** Test seam: replaces the SDK's HTTP transport; its logging code still runs. */
  fetchApi?: typeof fetch,
): PineconeClient {
  // The SDK wires its request/response logging when it is constructed, so the debug
  // variables must be cleared first: PINECONE_DEBUG prints bodies (which can echo the key or
  // contain the user's question) and PINECONE_DEBUG_CURL prints the Api-Key header.
  disableSdkDiagnostics();
  return new Pinecone({
    apiKey,
    maxRetries: 0,
    ...(fetchApi ? { fetchApi } : {}),
  });
}

function buildBackend(
  config: RuntimeConfig,
  sources: RuntimeSources,
): RetrievalBackend {
  if (config.backend === 'local')
    return new LocalBackend({ configDir: config.configDir });
  if (!config.pineconeApiKey) throw new AppError('MISSING_KEY');
  const settings = pineconeConfig(
    { rerankModel: config.rerankModel },
    sources.env,
  );
  try {
    const client = (sources.createPineconeClient ?? createPineconeClient)(
      config.pineconeApiKey,
    );
    return new PineconeBackend({ client, config: settings });
  } catch {
    // SDK construction failures can include credentials; do not retain even a cause.
    throw new AppError('BACKEND_UNAVAILABLE');
  }
}

/** Config sources, injectable so tests never read the real home directory or environment. */
export interface RuntimeSources {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  isTTY?: boolean;
  createPineconeClient?: (apiKey: string) => PineconeClient;
}

export const createRuntimeFrom =
  (sources: RuntimeSources = {}): RuntimeFactory =>
  async (options) => {
    const config = await resolveConfig({
      ...sources,
      needsLlm: options.needsLlm,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
      prompt: promptSecret,
      choose: promptChoice,
    });
    const configDir = config.configDir;
    const cacheDir = defaultCacheDir(configDir);
    return {
      backend: buildBackend(config, sources),
      registry: new Registry(configDir),
      fetcher: (url, options) =>
        safeFetch(url, {
          cacheDir,
          signal: options?.signal,
          validateUrl: options?.validateUrl,
          refresh: options?.refresh,
          parseLimits: options?.parseLimits,
        }),
      now: () => new Date(),
      maxDocs: config.maxDocs,
      retrievalMode: config.retrievalMode,
      port: config.port,
      get answerProvider() {
        return createProvider(providerConfig(config, 'answer'));
      },
      get extractProvider() {
        return createProvider(providerConfig(config, 'extract'));
      },
    };
  };

export const createRuntime: RuntimeFactory = createRuntimeFrom();
