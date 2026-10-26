/**
 * Cross-reference following (#274).
 *
 * A retrieved passage often leans on another part of the bill: "the eligible entities described
 * in section 3", "subject to subsection (b)". Without that section the model can only say the
 * passage doesn't explain it, which is exactly the kind of non-answer readers saw. So, like
 * definition injection, after retrieval we look at the sections the hits point to (chunk
 * `refs`, resolved to section ids at enrich time) and append the opening chunk of each one that
 * is not already in the result. One hop only: the appended sections' own references are not
 * followed, which keeps the prompt bounded and predictable.
 *
 * Whole-bill answers (#273) do not need this; it matters for bills over the whole-bill budget.
 */
import {
  makeChunkId,
  type RetrievalBackend,
  type SearchHit,
} from '../model/index.js';

/** At most this many referenced sections are appended to a result. */
export const MAX_FOLLOWED_REFERENCES = 3;

/**
 * Section ids the hits refer to that no hit already covers, in order of first appearance
 * (best-ranked hit first), so the cap keeps the references of the most relevant passages.
 */
export function referencedSectionsToFollow(
  hits: readonly SearchHit[],
): string[] {
  const covered = new Set(
    hits.flatMap((h) => [
      h.chunk.sectionId,
      ...(h.chunk.coveredSectionIds ?? []),
    ]),
  );
  const out: string[] = [];
  for (const { chunk } of hits) {
    // Stored chunks from older indexes or thin test doubles may lack `refs`; treat that as none.
    const refs: unknown = chunk.refs;
    if (!Array.isArray(refs)) continue;
    for (const id of refs)
      if (typeof id === 'string' && !covered.has(id) && !out.includes(id))
        out.push(id);
  }
  return out;
}

export interface FollowRequest {
  backend: RetrievalBackend;
  docId: string;
  hits: readonly SearchHit[];
  /** Struck text is followed only when the question is about changes. */
  includeDeleted: boolean;
  signal?: AbortSignal | undefined;
}

/**
 * The opening chunk of up to `MAX_FOLLOWED_REFERENCES` referenced sections, in priority order.
 * Chunk ids are deterministic, so this is one `getChunks` call and no search: a reference is
 * followed because the bill names it, never because it happens to rank.
 */
export async function findReferencedSections(
  req: FollowRequest,
): Promise<SearchHit[]> {
  const ids = referencedSectionsToFollow(req.hits);
  if (ids.length === 0) return [];
  req.signal?.throwIfAborted();
  const chunks = await req.backend.getChunks(
    req.docId,
    ids.map((id) => makeChunkId(req.docId, id, 0)),
  );
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const out: SearchHit[] = [];
  for (const id of ids) {
    const chunk = byId.get(makeChunkId(req.docId, id, 0));
    if (!chunk) continue;
    if (chunk.amendmentStatus === 'deleted' && !req.includeDeleted) continue;
    out.push({ chunk, score: 0 });
    if (out.length === MAX_FOLLOWED_REFERENCES) break;
  }
  return out;
}
