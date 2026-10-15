import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import lock from '../../../../models.lock.json' with { type: 'json' };
import { BRAND } from '../../brand.js';
import { ensurePrivateSubdirectory } from '../../config-files.js';
import { AppError } from '../../model/index.js';
import {
  REQUIRED_MODEL_FILES,
  ensureVerifiedModelFiles,
  type FileFetcher,
  type LockedModel,
} from './model-files.js';

export const MODEL_LOCK = lock;
export const BGE_QUERY_PREFIX =
  'Represent this sentence for searching relevant passages: ';
export const defaultConfigDir = (): string =>
  join(homedir(), BRAND.configDirName);

export interface ModelIdentity {
  id: string;
  revision: string;
}

export interface Embedder {
  readonly model: ModelIdentity;
  readonly dims: number;
  ensureReady(signal?: AbortSignal): Promise<void>;
  embed(
    texts: readonly string[],
    purpose: 'query' | 'document',
    signal?: AbortSignal,
  ): Promise<{
    vectors: Float32Array[];
    tokens: number;
  }>;
}

export interface Reranker {
  readonly model: ModelIdentity;
  ensureReady(signal?: AbortSignal): Promise<void>;
  score(
    query: string,
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[]>;
}

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export interface LocalModelOptions {
  configDir?: string;
  allowRemoteModels?: boolean;
  logger?: (message: string) => void;
  /** Test seam for the hash-verified model download. Defaults to global fetch. */
  fetchFile?: FileFetcher;
}

interface FloatTensor {
  data: Float32Array;
  dispose: () => void;
}
const ClassifierOutput = z.object({
  logits: z.custom<FloatTensor>(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'data' in value &&
      value.data instanceof Float32Array &&
      'dispose' in value &&
      typeof value.dispose === 'function',
  ),
});

// Transformers' env is process-global. Keep its configuration stable throughout
// a load, even when callers use different cache directories or offline settings.
let modelLoads = Promise.resolve();
function serializeModelLoad<T>(load: () => Promise<T>): Promise<T> {
  const pending = modelLoads.then(load);
  modelLoads = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

/** One context owns the lazy import and announcement shared by both adapters. */
export function createLocalModels(options: LocalModelOptions = {}): {
  embedder: Embedder;
  reranker: Reranker;
  dispose: () => Promise<void>;
} {
  const cacheDir = resolve(options.configDir ?? defaultConfigDir(), 'models');
  const allowRemote = options.allowRemoteModels ?? true;
  let announced = false;
  let runtime: Promise<typeof import('@huggingface/transformers')> | undefined;
  const loadRuntime = () => (runtime ??= import('@huggingface/transformers'));

  async function prepare(
    model: LockedModel,
  ): Promise<typeof import('@huggingface/transformers')> {
    // Create the cache 0700 ourselves; transformers.js would use the umask default.
    await ensurePrivateSubdirectory(cacheDir);
    const transformers = await loadRuntime();
    transformers.env.cacheDir = cacheDir;
    // transformers.js never downloads: our verifier fetched and hashed the locked files, and the
    // load below reads only the verified revision directory. Anything outside the locked files
    // fails loudly instead of being fetched unchecked.
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.useFSCache = true;
    const cached = await Promise.all(
      REQUIRED_MODEL_FILES.map(async (file) => {
        try {
          await access(join(cacheDir, model.id, model.revision, file));
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (allowRemote && !announced && cached.some((exists) => !exists)) {
      announced = true;
      const mb = Math.ceil(
        (lock.embedding.downloadBytes + lock.reranker.downloadBytes) /
          1_000_000,
      );
      (options.logger ?? console.error)(
        `Downloading local models (~${String(mb)} MB, first run only)…`,
      );
    }
    // Download (if needed) and hash-check every file before transformers.js loads anything.
    await ensureVerifiedModelFiles(model, {
      cacheDir,
      allowRemote,
      ...(options.fetchFile ? { fetchFile: options.fetchFile } : {}),
    });
    return transformers;
  }

  // Cache only successful loads: a failed download can be retried in the same process.
  let extractor:
    | Promise<import('@huggingface/transformers').FeatureExtractionPipeline>
    | undefined;
  const loadExtractor = () =>
    (extractor ??= serializeModelLoad(async () => {
      const { AutoTokenizer, AutoModel, FeatureExtractionPipeline } =
        await prepare(lock.embedding);
      const modelPath = join(
        cacheDir,
        lock.embedding.id,
        lock.embedding.revision,
      );
      const loadOptions = {
        revision: lock.embedding.revision,
        dtype: 'q8' as const,
        device: 'cpu' as const,
        cache_dir: cacheDir,
        local_files_only: true,
      };
      // The v4 pipeline() preflight omits revision when fetching config. Build
      // the same pipeline from pinned components so no request falls back to main.
      const tokenizer = await AutoTokenizer.from_pretrained(
        modelPath,
        loadOptions,
      );
      const model = await AutoModel.from_pretrained(modelPath, loadOptions);
      return new FeatureExtractionPipeline({
        task: 'feature-extraction',
        tokenizer,
        model,
      });
    }).catch((cause: unknown) => {
      extractor = undefined;
      // Keep the specific hash-mismatch / download message instead of masking it.
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Could not load the local embedding model.',
        { cause },
      );
    }));

  let classifier:
    | Promise<{
        tokenizer: import('@huggingface/transformers').PreTrainedTokenizer;
        model: import('@huggingface/transformers').PreTrainedModel;
      }>
    | undefined;
  const loadClassifier = () =>
    (classifier ??= serializeModelLoad(async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification } =
        await prepare(lock.reranker);
      const loadOptions = {
        revision: lock.reranker.revision,
        dtype: 'q8' as const,
        device: 'cpu' as const,
        cache_dir: cacheDir,
        local_files_only: true,
      };
      const modelPath = join(
        cacheDir,
        lock.reranker.id,
        lock.reranker.revision,
      );
      const tokenizer = await AutoTokenizer.from_pretrained(
        modelPath,
        loadOptions,
      );
      const model = await AutoModelForSequenceClassification.from_pretrained(
        modelPath,
        loadOptions,
      );
      return { tokenizer, model };
    }).catch((cause: unknown) => {
      classifier = undefined;
      // Keep the specific hash-mismatch / download message instead of masking it.
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Could not load the local reranking model.',
        { cause },
      );
    }));

  const embedder: Embedder = {
    model: lock.embedding,
    dims: lock.embedding.dims,
    async ensureReady(signal) {
      throwIfAborted(signal);
      await loadExtractor();
      throwIfAborted(signal);
    },
    async embed(texts, purpose, signal) {
      throwIfAborted(signal);
      if (!texts.length) return { vectors: [], tokens: 0 };
      const pipe = await loadExtractor();
      const vectors: Float32Array[] = [];
      let tokens = 0;
      // Bounded batches avoid large padded tensors on long bills. BGE uses CLS pooling.
      for (let start = 0; start < texts.length; start += 8) {
        throwIfAborted(signal);
        const batch = texts
          .slice(start, start + 8)
          .map((text) =>
            purpose === 'query' ? BGE_QUERY_PREFIX + text : text,
          );
        const inputs = pipe.tokenizer(batch, {
          padding: true,
          truncation: true,
        });
        for (const value of inputs.attention_mask.data) tokens += Number(value);
        const tensor = await pipe(batch, { pooling: 'cls', normalize: true });
        try {
          const data = new Float32Array(tensor.size);
          let offset = 0;
          for (const value of tensor.data) data[offset++] = Number(value);
          for (let row = 0; row < batch.length; row++) {
            vectors.push(
              data.slice(row * embedder.dims, (row + 1) * embedder.dims),
            );
          }
        } finally {
          tensor.dispose();
        }
      }
      throwIfAborted(signal);
      return { vectors, tokens };
    },
  };
  const reranker: Reranker = {
    model: lock.reranker,
    async ensureReady(signal) {
      throwIfAborted(signal);
      await loadClassifier();
      throwIfAborted(signal);
    },
    async score(query, texts, signal) {
      throwIfAborted(signal);
      if (!texts.length) return [];
      const { tokenizer, model } = await loadClassifier();
      const scores: number[] = [];
      for (const text of texts) {
        throwIfAborted(signal);
        const inputs = tokenizer(query, {
          text_pair: text,
          padding: true,
          truncation: true,
        });
        const output: unknown = await model(inputs);
        const parsed = ClassifierOutput.safeParse(output);
        if (!parsed.success)
          throw new AppError(
            'BACKEND_UNAVAILABLE',
            'Unexpected local reranker output.',
          );
        const { logits } = parsed.data;
        try {
          if (logits.data.length !== 1) {
            throw new AppError(
              'BACKEND_UNAVAILABLE',
              'Unexpected local reranker output.',
            );
          }
          scores.push(Number(logits.data[0]));
        } finally {
          logits.dispose();
        }
      }
      throwIfAborted(signal);
      return scores;
    },
  };
  return {
    embedder,
    reranker,
    async dispose() {
      if (extractor) await (await extractor).dispose();
      if (classifier) await (await classifier).model.dispose();
      extractor = undefined;
      classifier = undefined;
    },
  };
}
