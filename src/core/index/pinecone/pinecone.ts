/**
 * Built against @pinecone-database/pinecone 9.0.0, API 2026-07 (2026-10-13).
 * https://github.com/pinecone-io/pinecone-ts-client/blob/v9.0.0/README.md
 * https://github.com/pinecone-io/pinecone-ts-client/releases/tag/v9.0.0
 * https://docs.pinecone.io/guides/inference/integrated-inference
 * https://docs.pinecone.io/guides/index-data/{create-an-index,upsert-data}
 * https://docs.pinecone.io/guides/search/{lexical-search,filter-by-metadata,rerank-results}
 * https://docs.pinecone.io/guides/manage-data/manage-namespaces
 * https://docs.pinecone.io/reference/api/database-limits/{operation-limits,rate-limits,object-limits}
 * v9's Documents API serves schema-based indexes; integrated embedding still uses records.
 * Starter supports the config defaults, AWS us-east-1, and 500 BGE rerank requests/month.
 */
import {
  Pinecone,
  type CreateIndexForModelOptions,
  type IntegratedRecord,
  type FetchOptions,
  type SearchRecordsOptions,
  type UpsertRecordsOptions,
  type RerankOptions,
} from '@pinecone-database/pinecone';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { contextualText } from '../../chunk/index.js';
import { estimateTokens } from '../../chunk/tokens.js';
import { pineconeConfig, type PineconeSettings } from '../../config.js';
import {
  AppError,
  Chunk,
  ZERO_USAGE,
  addUsage,
  type BackendUsage,
  type RetrievalBackend,
  type SearchRequest,
  type RerankRequest,
  type SearchHit,
  type StoredChunk,
  type UpsertProgress,
} from '../../model/index.js';
import {
  fromRecord,
  STORED_FIELDS,
  toRecord,
  translateFilter,
} from './metadata.js';

// Only the SDK surface used here. Unknown responses are validated below with zod.
export interface PineconeNamespace {
  upsertRecords(options: UpsertRecordsOptions): Promise<unknown>;
  searchRecords(options: SearchRecordsOptions): Promise<unknown>;
  fetch(options: FetchOptions): Promise<unknown>;
}
export interface PineconeIndex {
  namespace(docId: string): PineconeNamespace;
  describeIndexStats(): Promise<unknown>;
  deleteNamespace(docId: string): Promise<unknown>;
}
export interface PineconeClient {
  indexes: {
    createForModel(options: CreateIndexForModelOptions): Promise<unknown>;
    describe(name: string): Promise<unknown>;
  };
  index(name: string, host?: string): PineconeIndex;
  inference: { rerank(options: RerankOptions): Promise<unknown> };
}
export interface PineconeBackendOptions {
  apiKey?: string;
  config?: Partial<PineconeSettings>;
  client?: PineconeClient;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logUsage?: (event: {
    backend: 'pinecone';
    operation: string;
    usage: BackendUsage;
  }) => void;
}

const Usage = z.object({
  embedTotalTokens: z.number().nonnegative().optional(),
  embed_total_tokens: z.number().nonnegative().optional(),
  readUnits: z.number().nonnegative().optional(),
  read_units: z.number().nonnegative().optional(),
  writeUnits: z.number().nonnegative().optional(),
  write_units: z.number().nonnegative().optional(),
  rerankUnits: z.number().nonnegative().optional(),
  rerank_units: z.number().nonnegative().optional(),
});
function usageOf(response: unknown): BackendUsage {
  const envelope = z.object({ usage: Usage.optional() }).parse(response ?? {});
  const usage = envelope.usage;
  return {
    embedTokens: usage?.embedTotalTokens ?? usage?.embed_total_tokens ?? 0,
    readUnits: usage?.readUnits ?? usage?.read_units ?? 0,
    writeUnits: usage?.writeUnits ?? usage?.write_units ?? 0,
    rerankUnits: usage?.rerankUnits ?? usage?.rerank_units ?? 0,
  };
}
const Stats = z.object({
  namespaces: z
    .record(
      z.string(),
      z.object({ recordCount: z.number().int().nonnegative() }),
    )
    .optional(),
});
const Description = z.object({
  host: z.string().min(1),
  status: z.object({ ready: z.boolean(), state: z.string().optional() }),
  deployment: z.object({
    deploymentType: z.string(),
    cloud: z.string().optional(),
    region: z.string().optional(),
  }),
  schema: z.object({
    fields: z.record(
      z.string(),
      z.object({ type: z.string().optional(), model: z.string().optional() }),
    ),
  }),
});
const SearchResponse = z.object({
  result: z.object({
    hits: z.array(
      z.object({ _id: z.string(), _score: z.number(), fields: z.unknown() }),
    ),
  }),
});
const FetchResponse = z.object({
  records: z.record(
    z.string(),
    z.object({ id: z.string(), metadata: z.unknown() }),
  ),
});
const COMPLETION_ID = 'complete';
const Completion = z.object({ doc_id: z.string(), version: z.literal(1) });
// Keep control records out of chunk searches, fetches and record counts.
// 80 ASCII characters for a SHA-256 docId, below the documented 512-character limit:
// https://sdk.pinecone.io/python/reference/async-index.html#pinecone.AsyncIndex.create_namespace
function completionNamespace(docId: string): string {
  return `ingest-complete:${docId}`;
}
const RerankResponse = z.object({
  data: z.array(
    z.object({ index: z.number().int().nonnegative(), score: z.number() }),
  ),
});

function hasStatus(error: unknown, status: number, name: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('status' in error && error.status === status) return true;
  if ('name' in error && error.name === name) return true;
  // SDK v9 has no dedicated 429 class or status property; its unmapped class encodes status here.
  return (
    status === 429 &&
    error instanceof Error &&
    error.name === 'PineconeUnmappedHttpError' &&
    /\bStatus: 429\b/.test(error.message)
  );
}
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('The operation was aborted.', 'AbortError');
}
function rateLimited(): AppError {
  return new AppError(
    'RATE_LIMITED',
    'Pinecone rate-limit retry budget exhausted.',
    {
      userMessage:
        "Pinecone's Starter tier is rate-limited for requests or embedding tokens. Please retry later.",
    },
  );
}
// Thrown by retryRateLimit when a request keeps getting 429s: the caller should send less.
class PersistentRateLimit extends Error {}
// A batch that is still throttled after this many 429s or this long is probably too big.
const SHRINK_AFTER_429S = 3;
const SHRINK_AFTER_MS = 60_000;
const MAX_UPSERT_RECORDS = 96;
function nextBackoffMs(ms: number): number {
  return Math.min(ms * 2, 30_000);
}
function retryAfterMs(error: unknown, now: number): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  let value: unknown = 'retryAfter' in error ? error.retryAfter : undefined;
  const response = 'response' in error ? error.response : undefined;
  const headers =
    'headers' in error
      ? error.headers
      : typeof response === 'object' &&
          response !== null &&
          'headers' in response
        ? response.headers
        : undefined;
  if (value === undefined) {
    if (headers instanceof Headers) value = headers.get('retry-after');
    else if (typeof headers === 'object' && headers !== null)
      value = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === 'retry-after',
      )?.[1];
  }
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const seconds =
    typeof value === 'number'
      ? value
      : /^[+-]?\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (Number.isFinite(seconds))
    return seconds >= 0 ? seconds * 1_000 : undefined;
  const date = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
// The SDK records API has no signal option. Stop waiting promptly; an in-flight
// write may still finish remotely, but must never publish ingest completion here.
async function boundedAttempt<T>(
  run: () => Promise<T>,
  remainingMs: number,
  timeoutError: AppError,
  signal?: AbortSignal,
): Promise<T> {
  abortIfNeeded(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
    }, remainingMs);
    onAbort = () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const attempt = Promise.resolve().then(() => {
      abortIfNeeded(signal);
      return run();
    });
    return await Promise.race([attempt, interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'AbortError')
      throw new DOMException('The operation was aborted.', 'AbortError');
    // SDK errors can echo headers and credentials. Never retain the raw error, even as a cause.
    if (hasStatus(error, 401, 'PineconeAuthorizationError'))
      throw new AppError('MISSING_KEY', 'Pinecone rejected the API key.', {
        userMessage:
          'Pinecone rejected the API key in PINECONE_API_KEY (or your saved config). Check it and try again.',
      });
    if (hasStatus(error, 429, 'PineconeRateLimitError')) throw rateLimited();
    throw new AppError('BACKEND_UNAVAILABLE');
  }
}

export class PineconeBackend implements RetrievalBackend {
  readonly kind = 'pinecone' as const;
  readonly config: PineconeSettings;
  readonly indexNames: { dense: string; sparse: string };
  private readonly client: PineconeClient;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: NonNullable<PineconeBackendOptions['sleep']>;
  private readonly logUsage: NonNullable<PineconeBackendOptions['logUsage']>;
  private initialization:
    Promise<{ dense: PineconeIndex; sparse: PineconeIndex }> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly expectedIds = new Map<string, Set<string>>();

  constructor(options: PineconeBackendOptions = {}) {
    this.config = pineconeConfig(options.config);
    this.indexNames = {
      dense: `${this.config.indexPrefix}dense`,
      sparse: `${this.config.indexPrefix}sparse`,
    };
    const apiKey = (options.apiKey ?? process.env.PINECONE_API_KEY)?.trim();
    if (!options.client && !apiKey) throw new AppError('MISSING_KEY');
    // The adapter owns the retry budget and cancellation; don't stack SDK retries.
    this.client =
      options.client ?? new Pinecone({ apiKey: apiKey ?? '', maxRetries: 0 });
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.logUsage =
      options.logUsage ??
      ((event) => {
        console.info(event);
      });
  }

  // Keep writes and deletes ordered within this backend instance.
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(() => safe(run));
    this.pending = next;
    return next;
  }
  private report(operation: string, response: unknown): BackendUsage {
    const usage = usageOf(response);
    this.logUsage({ backend: this.kind, operation, usage });
    return usage;
  }
  // Share successful initialization across every operation; a failure can be retried.
  private readyIndexes(
    signal?: AbortSignal,
  ): Promise<{ dense: PineconeIndex; sparse: PineconeIndex }> {
    this.initialization ??= safe(async () => {
      abortIfNeeded(signal);
      const indexes = {} as { dense: PineconeIndex; sparse: PineconeIndex };
      for (const kind of ['dense', 'sparse'] as const) {
        abortIfNeeded(signal);
        const name = this.indexNames[kind];
        const model =
          kind === 'dense' ? this.config.denseModel : this.config.sparseModel;
        await this.client.indexes.createForModel({
          name,
          cloud: this.config.cloud,
          region: this.config.region,
          embed: { model, fieldMap: { text: 'embed_text' } },
          suppressConflicts: true,
        });
        const deadline = this.now() + this.config.timeoutMs;
        for (;;) {
          abortIfNeeded(signal);
          const description = Description.parse(
            await this.client.indexes.describe(name),
          );
          abortIfNeeded(signal);
          if (description.status.ready) {
            const field = description.schema.fields.embed_text;
            if (
              description.deployment.deploymentType !== 'managed' ||
              description.deployment.cloud !== this.config.cloud ||
              description.deployment.region !== this.config.region ||
              field?.type !== 'semantic_text' ||
              field.model !== model
            )
              throw new AppError(
                'BACKEND_UNAVAILABLE',
                'An existing Pinecone index has incompatible settings.',
              );
            indexes[kind] = this.client.index(name, description.host);
            break;
          }
          if (
            description.status.state === 'InitializationFailed' ||
            description.status.state === 'Terminated' ||
            this.now() >= deadline
          )
            throw new AppError(
              'BACKEND_UNAVAILABLE',
              'Pinecone indexes did not become ready.',
            );
          await this.sleep(this.config.pollIntervalMs, signal);
        }
      }
      return indexes;
    }).catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  ensureReady(signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      abortIfNeeded(signal);
      await this.readyIndexes(signal);
    });
  }

  hasDocument(docId: string): Promise<boolean> {
    return this.serial(() => this.isComplete(docId));
  }
  private async isComplete(docId: string): Promise<boolean> {
    const { dense } = await this.readyIndexes();
    let response: unknown;
    try {
      response = await dense
        .namespace(completionNamespace(docId))
        .fetch({ ids: [COMPLETION_ID] });
    } catch (error) {
      if (hasStatus(error, 404, 'PineconeNotFoundError')) return false;
      throw error;
    }
    const record = FetchResponse.parse(response).records[COMPLETION_ID];
    this.report('fetch:completion', response);
    if (!record) return false;
    if (
      record.id !== COMPLETION_ID ||
      Completion.parse(record.metadata).doc_id !== docId
    )
      throw new AppError('BACKEND_UNAVAILABLE');
    return true;
  }
  private async removeCompletion(docId: string): Promise<void> {
    const { dense } = await this.readyIndexes();
    try {
      await dense.deleteNamespace(completionNamespace(docId));
    } catch (error) {
      if (!hasStatus(error, 404, 'PineconeNotFoundError')) throw error;
    }
  }
  private async pollCompletion(
    docId: string,
    expected: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = this.now() + Math.min(this.config.timeoutMs, 10_000);
    let backoffMs = 250;
    for (;;) {
      abortIfNeeded(signal);
      const complete = await this.isComplete(docId);
      abortIfNeeded(signal);
      if (complete === expected) return;
      const remainingMs = deadline - this.now();
      // The write succeeded; delayed visibility must not turn it into a failed ingest/delete.
      if (remainingMs <= 0) return;
      await this.sleep(Math.min(backoffMs, remainingMs), signal);
      backoffMs = nextBackoffMs(backoffMs);
    }
  }
  private async retryRateLimit<T>(
    run: () => Promise<T>,
    budgetMs: number,
    signal?: AbortSignal,
    giveUpEarly = false,
  ): Promise<T> {
    const startedAt = this.now();
    const deadline = startedAt + budgetMs;
    let backoffMs = 1_000;
    let wasRateLimited = false;
    let rateLimits = 0;
    for (;;) {
      abortIfNeeded(signal);
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) throw rateLimited();
      try {
        const result = await boundedAttempt(
          run,
          remainingMs,
          wasRateLimited ? rateLimited() : new AppError('BACKEND_UNAVAILABLE'),
          signal,
        );
        abortIfNeeded(signal);
        return result;
      } catch (error) {
        abortIfNeeded(signal);
        if (!hasStatus(error, 429, 'PineconeRateLimitError')) throw error;
        wasRateLimited = true;
        rateLimits += 1;
        if (
          giveUpEarly &&
          (rateLimits >= SHRINK_AFTER_429S ||
            this.now() - startedAt >= SHRINK_AFTER_MS)
        )
          throw new PersistentRateLimit();
        const waitMs =
          retryAfterMs(error, this.now()) ??
          Math.min(30_000, backoffMs * (0.5 + this.random()));
        // A server-requested wait may exceed our per-wait cap. Split it without
        // retrying early, while still bounding the total operation and allowing abort.
        const retryAt = this.now() + Math.max(1, waitMs);
        while (this.now() < retryAt) {
          abortIfNeeded(signal);
          const remainingMs = deadline - this.now();
          if (remainingMs <= 0) throw rateLimited();
          await this.sleep(
            Math.min(30_000, retryAt - this.now(), remainingMs),
            signal,
          );
        }
        backoffMs = nextBackoffMs(backoffMs);
      }
    }
  }
  /**
   * Upserts one batch. If it keeps hitting 429, halve it and retry the halves, because an
   * over-large request can never succeed. A single record gets the full retry budget.
   */
  private async upsertBatch(
    index: PineconeIndex,
    docId: string,
    batch: readonly IntegratedRecord[],
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    try {
      const response = await this.retryRateLimit(
        () => index.namespace(docId).upsertRecords({ records: [...batch] }),
        this.config.upsertRetryBudgetMs,
        signal,
        batch.length > 1,
      );
      return [response];
    } catch (error) {
      if (!(error instanceof PersistentRateLimit)) throw error;
      const middle = Math.ceil(batch.length / 2);
      return [
        ...(await this.upsertBatch(
          index,
          docId,
          batch.slice(0, middle),
          signal,
        )),
        ...(await this.upsertBatch(index, docId, batch.slice(middle), signal)),
      ];
    }
  }
  private async remove(docId: string): Promise<void> {
    // Invalidate completion before deleting chunks, even if chunk cleanup fails.
    await this.removeCompletion(docId);
    for (const index of Object.values(await this.readyIndexes())) {
      try {
        await index.deleteNamespace(docId);
      } catch (error) {
        if (!hasStatus(error, 404, 'PineconeNotFoundError')) throw error;
      }
    }
    this.expectedIds.set(docId, new Set());
  }

  upsertChunks(
    docId: string,
    chunks: readonly Chunk[],
    onProgress?: (p: UpsertProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ usage: BackendUsage }> {
    return this.serial(async () => {
      abortIfNeeded(signal);
      const indexes = await this.readyIndexes(signal);
      const records = chunks.map((chunk) => {
        const parsed = Chunk.safeParse(chunk);
        if (!parsed.success || chunk.docId !== docId)
          throw new AppError('INVALID_INPUT');
        return toRecord(parsed.data);
      });
      if (!records.length) return { usage: { ...ZERO_USAGE } };
      const wasComplete = await this.isComplete(docId);
      // A failed update can leave the indexes inconsistent, including across restarts.
      if (wasComplete) await this.removeCompletion(docId);
      let usage = { ...ZERO_USAGE };
      try {
        // 96 text records; NDJSON must also stay below 2 MB, including UTF-8 and separators.
        let offset = 0;
        while (offset < records.length) {
          if (offset > 0 && this.config.upsertBatchDelayMs > 0) {
            await this.sleep(this.config.upsertBatchDelayMs, signal);
          }
          const batch: typeof records = [];
          let bytes = 0;
          let tokens = 0;
          while (
            offset + batch.length < records.length &&
            batch.length < MAX_UPSERT_RECORDS
          ) {
            const record = records[offset + batch.length];
            if (!record) break;
            const size = Buffer.byteLength(JSON.stringify(record)) + 1;
            const recordTokens = estimateTokens(String(record.embed_text));
            if (bytes + size > 2_000_000) break;
            // An oversized single record still goes alone; the token cap only groups records.
            if (
              batch.length > 0 &&
              tokens + recordTokens > this.config.upsertMaxBatchTokens
            )
              break;
            batch.push(record);
            bytes += size;
            tokens += recordTokens;
          }
          for (const kind of ['dense', 'sparse'] as const) {
            abortIfNeeded(signal);
            const responses = await this.upsertBatch(
              indexes[kind],
              docId,
              batch,
              signal,
            );
            // SDK 9.0.0 returns void here. Unreported usage stays zero; never estimate billed tokens.
            for (const response of responses)
              usage = addUsage(usage, this.report(`upsert:${kind}`, response));
          }
          offset += batch.length;
          onProgress?.({ done: offset, total: chunks.length });
        }
        // Publish durable completion only after every batch succeeds in both indexes.
        abortIfNeeded(signal);
        const response = await this.retryRateLimit(
          () =>
            indexes.dense.namespace(completionNamespace(docId)).upsertRecords({
              records: [
                {
                  _id: COMPLETION_ID,
                  embed_text: 'Document ingest complete.',
                  doc_id: docId,
                  version: 1,
                },
              ],
            }),
          this.config.upsertRetryBudgetMs,
          signal,
        );
        usage = addUsage(usage, this.report('upsert:completion', response));
        const ids = this.expectedIds.get(docId) ?? new Set<string>();
        for (const record of records) ids.add(String(record._id));
        this.expectedIds.set(docId, ids);
      } catch (error) {
        // Don't let a failed ingest appear complete just because dense writes succeeded.
        if (!wasComplete) await this.remove(docId).catch(() => undefined);
        throw error;
      }
      await this.pollCompletion(docId, true, signal);
      return { usage };
    });
  }

  search(
    req: SearchRequest,
  ): Promise<{ hits: SearchHit[]; usage: BackendUsage }> {
    return this.serial(async () => {
      abortIfNeeded(req.signal);
      if (!Number.isInteger(req.topK) || req.topK < 1 || req.topK > 10_000)
        throw new AppError('INVALID_INPUT');
      const filter = translateFilter(req.filter);
      const indexes = await this.readyIndexes(req.signal);
      let response: unknown;
      try {
        response = await this.retryRateLimit(
          () =>
            indexes[req.index].namespace(req.docId).searchRecords({
              query: {
                topK: req.topK,
                inputs: { text: req.query },
                ...(filter ? { filter } : {}),
              },
              fields: STORED_FIELDS,
            }),
          this.config.queryRetryBudgetMs,
          req.signal,
        );
      } catch (error) {
        if (!hasStatus(error, 404, 'PineconeNotFoundError')) throw error;
        return { hits: [], usage: { ...ZERO_USAGE } };
      }
      abortIfNeeded(req.signal);
      const parsed = SearchResponse.parse(response);
      const hits = parsed.result.hits
        .map((hit) => ({
          chunk: fromRecord(hit._id, hit.fields, req.docId),
          score: hit._score,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, req.topK);
      const usage = this.report(`search:${req.index}`, response);
      return { hits, usage };
    });
  }

  getChunks(docId: string, ids: readonly string[]): Promise<StoredChunk[]> {
    return this.serial(async () => {
      const namespace = (await this.readyIndexes()).dense.namespace(docId);
      const chunks: StoredChunk[] = [];
      for (let offset = 0; offset < ids.length; offset += 1_000) {
        const batch = ids.slice(offset, offset + 1_000);
        let response: unknown;
        try {
          response = await namespace.fetch({ ids: batch });
        } catch (error) {
          if (hasStatus(error, 404, 'PineconeNotFoundError')) continue;
          throw error;
        }
        const parsed = FetchResponse.parse(response);
        this.report('fetch', response);
        for (const id of batch) {
          const record = parsed.records[id];
          if (record) {
            if (record.id !== id) throw new AppError('BACKEND_UNAVAILABLE');
            chunks.push(fromRecord(id, record.metadata, docId));
          }
        }
      }
      return chunks;
    });
  }

  rerank(
    req: RerankRequest,
  ): Promise<{ hits: SearchHit[]; usage: BackendUsage }> {
    return this.serial(async () => {
      abortIfNeeded(req.signal);
      if (!Number.isInteger(req.topN) || req.topN < 1)
        throw new AppError('INVALID_INPUT');
      await this.readyIndexes(req.signal);
      if (!req.hits.length) return { hits: [], usage: { ...ZERO_USAGE } };
      if (req.hits.length > 100)
        throw new AppError(
          'INVALID_INPUT',
          'Rerank accepts at most 100 chunks.',
        );
      const topN = Math.min(req.topN, req.hits.length);
      const response = await this.retryRateLimit(
        () =>
          this.client.inference.rerank({
            model: this.config.rerankModel,
            query: req.query,
            documents: req.hits.map((hit) => ({
              id: hit.chunk.id,
              text: contextualText(hit.chunk),
            })),
            rankFields: ['text'],
            topN,
            returnDocuments: false,
            parameters: { truncate: 'END' },
          }),
        this.config.queryRetryBudgetMs,
        req.signal,
      );
      abortIfNeeded(req.signal);
      const parsed = RerankResponse.parse(response);
      const seen = new Set<number>();
      const hits = parsed.data
        .map((item) => {
          const hit = req.hits[item.index];
          if (!hit || seen.has(item.index))
            throw new AppError('BACKEND_UNAVAILABLE');
          seen.add(item.index);
          return { chunk: hit.chunk, score: item.score };
        })
        .sort((a, b) => b.score - a.score);
      if (hits.length !== topN) throw new AppError('BACKEND_UNAVAILABLE');
      const usage = this.report('rerank', response);
      return { hits, usage };
    });
  }
  deleteDocument(docId: string, signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      abortIfNeeded(signal);
      await this.readyIndexes(signal);
      await this.remove(docId);
      await this.pollCompletion(docId, false, signal);
    });
  }

  async settle(signal?: AbortSignal): Promise<void> {
    await this.ensureReady(signal);
    for (const [docId, ids] of this.expectedIds)
      await settle(this, docId, ids.size, signal);
  }
  recordCounts(docId: string): Promise<number[]> {
    return safe(async () => {
      const counts: number[] = [];
      for (const index of Object.values(await this.readyIndexes())) {
        const stats = Stats.parse(await index.describeIndexStats());
        counts.push(stats.namespaces?.[docId]?.recordCount ?? 0);
      }
      return counts;
    });
  }
}

/** Poll both indexes and completion after test writes/deletes; a timeout is a failure. */
export async function settle(
  backend: PineconeBackend,
  docId: string,
  expectedCount: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + backend.config.timeoutMs;
  const expectedComplete = expectedCount > 0;
  for (;;) {
    abortIfNeeded(signal);
    if (
      (await backend.recordCounts(docId)).every(
        (count) => count === expectedCount,
      ) &&
      (await backend.hasDocument(docId)) === expectedComplete
    )
      return;
    if (Date.now() >= deadline)
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Pinecone records did not settle.',
      );
    await safe(() =>
      delay(backend.config.pollIntervalMs, undefined, { signal }),
    );
  }
}
