// Frozen snapshot of the rc.2 contract src/core/model/chunk.ts (commit fb663d1), used only to prove
// that rc.2 readers still parse data written by later versions. Do not edit.
/**
 * Chunks: the unit that is embedded, indexed, retrieved and cited.
 * Produced by core/chunk from a NormalizedDoc, enriched by core/enrich.
 */
import { z } from 'zod';
import { SectionId, SourceLocation } from './doc.js';

/** Heuristic classification used by chip filters (spec §5.4). */
export const ChunkType = z.enum([
  'definition',
  'operative',
  'findings',
  'appropriation',
  'penalty',
  'effective_date',
  'other',
]);
export type ChunkType = z.infer<typeof ChunkType>;

/**
 * Amendment status of a chunk.
 * - `deleted`: the chunk holds only struck text (emitted separately so it is never mistaken
 *   for current law, but `what-changes` can still find it).
 * - `inserted`: a normal chunk that contains newly added text.
 * - `unchanged`: no amendment markup.
 */
export const AmendmentStatus = z.enum(['unchanged', 'inserted', 'deleted']);
export type AmendmentStatus = z.infer<typeof AmendmentStatus>;

export const Chunk = SourceLocation.extend({
  /** Deterministic: `${docId}:${sectionId}:${n}`, so re-ingest is an idempotent upsert. */
  id: z.string().min(1),
  docId: z.string().min(1),
  sectionId: SectionId,
  sectionNum: z.string().optional(),
  heading: z.string().optional(),
  /** Human-readable path, e.g. "Sec. 4 > (b) > (2) Eligibility". */
  breadcrumb: z.string(),
  chunkType: ChunkType,
  amendmentStatus: AmendmentStatus,
  /** Raw text for display and for the answer prompt (no breadcrumb). */
  text: z.string().min(1),
  /** What gets embedded: breadcrumb prefix + text (contextual retrieval). */
  embedText: z.string().min(1),
  /** Defined terms (from this document) that appear in the text. Used for definition injection. */
  definedTermsUsed: z.array(z.string()),
  /** Internal cross-references resolved to section ids. */
  refs: z.array(z.string()),
  /**
   * Sections whose own text is in this chunk: `sectionId` plus any small sibling subsections
   * the chunker merged into it. Absent means just `[sectionId]`. Citations to any of these are
   * valid for this chunk. (`refs` is for cross-references only.) Added in #59.
   */
  coveredSectionIds: z.array(SectionId).nonempty().optional(),
  /** For `chunkType: 'definition'` chunks, the term defined. */
  definesTerm: z.string().optional(),
  tokenCount: z.number().int().nonnegative(),
});
export type Chunk = z.infer<typeof Chunk>;

/** What a backend returns for a hit: the chunk without the embedding-only field. */
export const StoredChunk = Chunk.omit({ embedText: true });
export type StoredChunk = z.infer<typeof StoredChunk>;

export function makeChunkId(
  docId: string,
  sectionId: string,
  n: number,
): string {
  return `${docId}:${sectionId}:${String(n)}`;
}

/**
 * Typed metadata filter. Backends translate it (Pinecone: `$in` filters; local: in-process).
 * All present fields must match (AND); values within a field are OR'd.
 */
export const ChunkFilter = z.object({
  chunkType: z.array(ChunkType).nonempty().optional(),
  amendmentStatus: z.array(AmendmentStatus).nonempty().optional(),
  sectionIds: z.array(SectionId).nonempty().optional(),
  /** Match chunks that define any of these terms. */
  definesTerm: z.array(z.string()).nonempty().optional(),
});
export type ChunkFilter = z.infer<typeof ChunkFilter>;
