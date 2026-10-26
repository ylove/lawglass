/** Small fakes shared by the breakdown tests (not part of the package). */
import { hit } from '../answer/fixtures.js';
import {
  makeChunkId,
  ZERO_USAGE,
  type RetrievalBackend,
  type SearchHit,
  type Section,
  type StoredChunk,
} from '../model/index.js';

export const DOC_ID = 'd'.repeat(64);

export function sec(
  id: string,
  heading: string,
  text: string,
  children: Section[] = [],
): Section {
  return {
    id,
    num: id.replace(/^sec-/, ''),
    heading,
    level: 1,
    spans: text ? [{ text, status: 'unchanged' }] : [],
    children,
  };
}

/** One live chunk per section, numbered the way the chunker numbers them. */
export function chunkHit(
  sectionId: string,
  text: string,
  over: Partial<StoredChunk> = {},
): SearchHit {
  return hit({
    id: makeChunkId(DOC_ID, sectionId, 0),
    docId: DOC_ID,
    sectionId,
    breadcrumb: `Bill > ${sectionId}`,
    text,
    ...over,
  });
}

/** A backend that serves a fixed set of chunks by id and answers definition searches by term. */
export function fakeBackend(hits: readonly SearchHit[]): RetrievalBackend & {
  getChunkCalls: number;
  searchCalls: number;
} {
  const byId = new Map(hits.map((h) => [h.chunk.id, h.chunk]));
  const backend = {
    kind: 'local' as const,
    getChunkCalls: 0,
    searchCalls: 0,
    ensureReady: () => Promise.resolve(),
    hasDocument: () => Promise.resolve(true),
    upsertChunks: () => Promise.resolve({ usage: ZERO_USAGE }),
    search: (req: Parameters<RetrievalBackend['search']>[0]) => {
      backend.searchCalls++;
      const terms = req.filter?.definesTerm ?? [];
      return Promise.resolve({
        hits: hits.filter(
          (h) =>
            h.chunk.definesTerm !== undefined &&
            terms.includes(h.chunk.definesTerm),
        ),
        usage: ZERO_USAGE,
      });
    },
    getChunks: (_docId: string, ids: readonly string[]) => {
      backend.getChunkCalls++;
      return Promise.resolve(
        ids.flatMap((id) => {
          const chunk = byId.get(id);
          return chunk ? [chunk] : [];
        }),
      );
    },
    rerank: () => Promise.resolve({ hits: [], usage: ZERO_USAGE }),
    deleteDocument: () => Promise.resolve(),
  };
  return backend;
}
