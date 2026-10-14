import { classifyChunk } from '../chunk/index.js';
import type { ChunkType } from '../model/index.js';

/**
 * The chunker's heuristics already cover headings and "as used in" boilerplate; enrichment
 * only overrides them when it has positively identified a definition, so a definition that
 * mentions a "fine" or an "effective date" is still filed as a definition.
 */
export function chunkTypeFor(
  text: string,
  heading: string | undefined,
  definesTerm: string | undefined,
): ChunkType {
  return definesTerm === undefined
    ? classifyChunk(text, heading)
    : 'definition';
}
