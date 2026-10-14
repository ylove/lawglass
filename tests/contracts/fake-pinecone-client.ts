/** In-memory Pinecone SDK surface, shared by adapter and runtime tests. */
import type {
  FetchOptions,
  SearchRecordsOptions,
  UpsertRecordsOptions,
  CreateIndexForModelOptions,
  RerankOptions,
  IntegratedRecord,
} from '@pinecone-database/pinecone';
import { vi } from 'vitest';
import { pineconeConfig } from '../../src/core/config.js';
import type { PineconeClient } from '../../src/core/index/pinecone/index.js';
import {
  fromRecord,
  toRecord,
} from '../../src/core/index/pinecone/metadata.js';
import type { ChunkFilter } from '../../src/core/model/index.js';
import { MemoryBackend } from './memory-backend.js';

export function fakePineconeClient(settings = pineconeConfig({}, {})) {
  function fakeIndex(kind: 'dense' | 'sparse') {
    const memory = new MemoryBackend();
    const records = new Map<string, Set<string>>();
    const storedRecords = new Map<string, Map<string, IntegratedRecord>>();
    const consistency = { upsertReads: 0, deleteReads: 0 };
    const pendingVisibility = new Map<
      string,
      { remainingReads: number; previous: Map<string, IntegratedRecord> }
    >();
    function delayVisibility(docId: string, remainingReads: number): void {
      if (!docId.startsWith('ingest-complete:')) return;
      pendingVisibility.set(docId, {
        remainingReads,
        previous: new Map(storedRecords.get(docId)),
      });
    }
    const upsert = vi.fn(
      async (
        docId: string,
        options: UpsertRecordsOptions,
      ): Promise<unknown> => {
        delayVisibility(docId, consistency.upsertReads);
        const chunks = options.records
          .filter((record) => record.section_id !== undefined)
          .map((record) => ({
            ...fromRecord(String(record._id), record, docId),
            embedText: String(record.embed_text),
          }));
        await memory.upsertChunks(docId, chunks);
        const ids = records.get(docId) ?? new Set<string>();
        const stored =
          storedRecords.get(docId) ?? new Map<string, IntegratedRecord>();
        for (const record of options.records) {
          const id = String(record._id);
          ids.add(id);
          stored.set(id, record);
        }
        records.set(docId, ids);
        storedRecords.set(docId, stored);
        return undefined; // The pinned SDK returns void, not a usage object.
      },
    );
    const search = vi.fn(
      async (
        docId: string,
        options: SearchRecordsOptions,
      ): Promise<unknown> => {
        const query = options.query.inputs as { text: string };
        const filter: ChunkFilter = {};
        const translated = options.query.filter as
          { $and: Record<string, { $in: string[] }>[] } | undefined;
        for (const clause of translated?.$and ?? []) {
          if (clause.section_id) filter.sectionIds = clause.section_id.$in;
          if (clause.defines_term) filter.definesTerm = clause.defines_term.$in;
          if (clause.chunk_type)
            filter.chunkType = clause.chunk_type.$in as NonNullable<
              ChunkFilter['chunkType']
            >;
          if (clause.amendment_status)
            filter.amendmentStatus = clause.amendment_status.$in as NonNullable<
              ChunkFilter['amendmentStatus']
            >;
        }
        const response = await memory.search({
          docId,
          index: kind,
          query: query.text,
          topK: options.query.topK,
          filter,
        });
        return {
          result: {
            hits: response.hits.map((hit) => ({
              _id: hit.chunk.id,
              _score: hit.score,
              fields: toRecord({ ...hit.chunk, embedText: hit.chunk.text }),
            })),
          },
          usage: { readUnits: 1, embedTotalTokens: 3 },
        };
      },
    );
    const fetch = vi.fn(
      (docId: string, options: FetchOptions): Promise<unknown> => {
        const pending = pendingVisibility.get(docId);
        const visible =
          pending && pending.remainingReads > 0
            ? pending.previous
            : storedRecords.get(docId);
        if (pending) {
          if (pending.remainingReads > 0) pending.remainingReads--;
          else pendingVisibility.delete(docId);
        }
        return Promise.resolve({
          records: Object.fromEntries(
            options.ids.flatMap((id) => {
              const record = visible?.get(id);
              return record ? [[id, { id, metadata: record }]] : [];
            }),
          ),
          usage: { readUnits: 1 },
        });
      },
    );
    const stats = vi.fn((): Promise<unknown> =>
      Promise.resolve({
        namespaces: Object.fromEntries(
          [...records].map(([id, ids]) => [id, { recordCount: ids.size }]),
        ),
      }),
    );
    const deleteNamespace = vi.fn(async (docId: string): Promise<unknown> => {
      delayVisibility(docId, consistency.deleteReads);
      await memory.deleteDocument(docId);
      records.delete(docId);
      storedRecords.delete(docId);
      return undefined;
    });
    return {
      memory,
      upsert,
      search,
      fetch,
      records,
      consistency,
      describeIndexStats: stats,
      deleteNamespace,
      namespace: (docId: string) => ({
        upsertRecords: (options: UpsertRecordsOptions) =>
          upsert(docId, options),
        searchRecords: (options: SearchRecordsOptions) =>
          search(docId, options),
        fetch: (options: FetchOptions) => fetch(docId, options),
      }),
    };
  }
  const dense = fakeIndex('dense');
  const sparse = fakeIndex('sparse');
  const describeIndex = vi.fn((name: string): Promise<unknown> =>
    Promise.resolve({
      host: `${name}.example.org`,
      status: { ready: true },
      deployment: {
        deploymentType: 'managed',
        cloud: settings.cloud,
        region: settings.region,
      },
      schema: {
        fields: {
          embed_text: {
            type: 'semantic_text',
            model: name.endsWith('dense')
              ? settings.denseModel
              : settings.sparseModel,
          },
        },
      },
    }),
  );
  const create = vi.fn(
    (_options: CreateIndexForModelOptions): Promise<unknown> =>
      Promise.resolve(undefined),
  );
  const rerank = vi.fn(async (options: RerankOptions): Promise<unknown> => {
    const documents = options.documents as { id: string; text: string }[];
    const chunks = await dense.memory.getChunks(
      documents[0]?.id.split(':')[0] ?? '',
      documents.map((doc) => doc.id),
    );
    const response = await dense.memory.rerank({
      query: options.query,
      topN: options.topN ?? documents.length,
      hits: chunks.map((chunk) => ({ chunk, score: 0 })),
    });
    return {
      data: response.hits.map((hit) => ({
        index: documents.findIndex((doc) => doc.id === hit.chunk.id),
        score: hit.score,
      })),
      usage: { rerankUnits: 1 },
    };
  });
  const client: PineconeClient = {
    indexes: { createForModel: create, describe: describeIndex },
    index: (name) => (name.endsWith('dense') ? dense : sparse),
    inference: { rerank },
  };
  return { client, dense, sparse, create, describeIndex, rerank };
}
