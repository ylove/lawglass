import type { StoredChunk } from '../model/index.js';

/**
 * The text a model sees for a chunk when ranking it: `breadcrumb: text`. The embedder indexes it
 * (as `embedText`) and the cross-encoder scores it at rerank time. Both need the heading path:
 * in a large bill many chunks read alike ("(a) In general.—The Secretary shall…") and only the
 * breadcrumb says which program or section they belong to. One function, so the two can't drift.
 */
export function contextualText(
  chunk: Pick<StoredChunk, 'breadcrumb' | 'text'>,
): string {
  return `${chunk.breadcrumb}: ${chunk.text}`;
}
