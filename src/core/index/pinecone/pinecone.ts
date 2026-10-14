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
  type FetchOptions,
  type SearchRecordsOptions,
  type UpsertRecordsOptions,
  type RerankOptions,
} from '@pinecone-database/pinecone';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
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
async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'AbortError')
      throw new DOMException('The operation was aborted.', 'AbortError');
    // SDK errors can echo headers and credentials. Never retain the raw error, even as a cause.
    if (hasStatus(error, 401, 'PineconeAuthorizationError'))
      throw new AppError('MISSING_KEY');
    if (hasStatus(error, 429, 'PineconeRateLimitError'))
      throw new AppError('RATE_LIMITED');
    throw new AppError('BACKEND_UNAVAILABLE');
  }
}

export class PineconeBackend implements RetrievalBackend {
  readonly kind = 'pinecone' as const;
  readonly config: PineconeSettings;
  readonly indexNames: { dense: string; sparse: string };
  private readonly client: PineconeClient;
  private readonly logUsage: NonNullable<PineconeBackendOptions['logUsage']>;
  private indexes: { dense: PineconeIndex; sparse: PineconeIndex } | undefined;
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
    this.client =
      options.client ?? new Pinecone({ apiKey: apiKey ?? '', maxRetries: 0 });
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
  private readyIndexes(): { dense: PineconeIndex; sparse: PineconeIndex } {
    if (!this.indexes)
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Call ensureReady before using Pinecone.',
      );
    return this.indexes;
  }

  ensureReady(signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      abortIfNeeded(signal);
      if (this.indexes) return;
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
        const deadline = Date.now() + this.config.timeoutMs;
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
            Date.now() >= deadline
          )
            throw new AppError(
              'BACKEND_UNAVAILABLE',
              'Pinecone indexes did not become ready.',
            );
          await delay(this.config.pollIntervalMs, undefined, { signal });
        }
      }
      this.indexes = indexes;
    });
  }

  hasDocument(docId: string): Promise<boolean> {
    return this.serial(async () => {
      const stats = Stats.parse(
        await this.readyIndexes().dense.describeIndexStats(),
      );
      return (stats.namespaces?.[docId]?.recordCount ?? 0) > 0;
    });
  }
  private async namespaceExists(docId: string): Promise<boolean> {
    const stats = Stats.parse(
      await this.readyIndexes().dense.describeIndexStats(),
    );
    return (stats.namespaces?.[docId]?.recordCount ?? 0) > 0;
  }
  private async remove(docId: string): Promise<void> {
    for (const index of Object.values(this.readyIndexes())) {
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
  ): Promise<{ usage: BackendUsage }> {
    return this.serial(async () => {
      const indexes = this.readyIndexes();
      const records = chunks.map((chunk) => {
        const parsed = Chunk.safeParse(chunk);
        if (!parsed.success || chunk.docId !== docId)
          throw new AppError('INVALID_INPUT');
        return toRecord(parsed.data);
      });
      if (!records.length) return { usage: { ...ZERO_USAGE } };
      const existed = await this.namespaceExists(docId);
      let usage = { ...ZERO_USAGE };
      try {
        // 96 text records; NDJSON must also stay below 2 MB, including UTF-8 and separators.
        let offset = 0;
        while (offset < records.length) {
          const batch: typeof records = [];
          let bytes = 0;
          while (offset + batch.length < records.length && batch.length < 96) {
            const record = records[offset + batch.length];
            if (!record) break;
            const size = Buffer.byteLength(JSON.stringify(record)) + 1;
            if (bytes + size > 2_000_000) break;
            batch.push(record);
            bytes += size;
          }
          for (const kind of ['dense', 'sparse'] as const) {
            const response = await indexes[kind]
              .namespace(docId)
              .upsertRecords({ records: batch });
            // SDK 9.0.0 returns void here. Unreported usage stays zero; never estimate billed tokens.
            usage = addUsage(usage, this.report(`upsert:${kind}`, response));
          }
          offset += batch.length;
          onProgress?.({ done: offset, total: chunks.length });
        }
        const ids = this.expectedIds.get(docId) ?? new Set<string>();
        for (const record of records) ids.add(String(record._id));
        this.expectedIds.set(docId, ids);
      } catch (error) {
        // Don't let a failed ingest appear complete just because dense writes succeeded.
        if (!existed) await this.remove(docId).catch(() => undefined);
        throw error;
      }
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
      let response: unknown;
      try {
        response = await this.readyIndexes()
          [req.index].namespace(req.docId)
          .searchRecords({
            query: {
              topK: req.topK,
              inputs: { text: req.query },
              ...(filter ? { filter } : {}),
            },
            fields: STORED_FIELDS,
          });
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
      const namespace = this.readyIndexes().dense.namespace(docId);
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
      if (!req.hits.length) return { hits: [], usage: { ...ZERO_USAGE } };
      if (req.hits.length > 100)
        throw new AppError(
          'INVALID_INPUT',
          'Rerank accepts at most 100 chunks.',
        );
      const topN = Math.min(req.topN, req.hits.length);
      const response = await this.client.inference.rerank({
        model: this.config.rerankModel,
        query: req.query,
        documents: req.hits.map((hit) => ({
          id: hit.chunk.id,
          text: hit.chunk.text,
        })),
        rankFields: ['text'],
        topN,
        returnDocuments: false,
        parameters: { truncate: 'END' },
      });
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
  deleteDocument(docId: string): Promise<void> {
    return this.serial(() => this.remove(docId));
  }

  async settle(signal?: AbortSignal): Promise<void> {
    await this.pending;
    for (const [docId, ids] of this.expectedIds)
      await settle(this, docId, ids.size, signal);
  }
  recordCounts(docId: string): Promise<number[]> {
    return safe(async () => {
      const counts: number[] = [];
      for (const index of Object.values(this.readyIndexes())) {
        const stats = Stats.parse(await index.describeIndexStats());
        counts.push(stats.namespaces?.[docId]?.recordCount ?? 0);
      }
      return counts;
    });
  }
}

/** Poll both indexes after test writes/deletes; a timeout is a failure, never a fixed sleep. */
export async function settle(
  backend: PineconeBackend,
  docId: string,
  expectedCount: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + backend.config.timeoutMs;
  for (;;) {
    abortIfNeeded(signal);
    if (
      (await backend.recordCounts(docId)).every(
        (count) => count === expectedCount,
      )
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
