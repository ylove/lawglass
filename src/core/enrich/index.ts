import { estimateTokens } from '../chunk/index.js';
import { Chunk, NormalizedDoc, AppError, makeChunkId } from '../model/index.js';
import { chunkTypeFor } from './chunk-type.js';
import {
  createTermMatcher,
  extractDefinitions,
  mergeDefinitions,
  segmentDefinitions,
} from './definitions.js';
import { collectExternalRefs, findInternalRefs } from './refs.js';
import { buildSectionIndex } from './section-index.js';

export { chunkTypeFor } from './chunk-type.js';
export {
  createTermMatcher,
  extractDefinitions,
  segmentDefinitions,
} from './definitions.js';
export {
  collectExternalRefs,
  findExternalMatches,
  findInternalRefs,
} from './refs.js';
export { buildSectionIndex } from './section-index.js';

export interface EnrichedDocument {
  /** The input document with `definitions` and `externalRefs` filled in. */
  doc: NormalizedDoc;
  chunks: Chunk[];
}

interface Piece {
  base: Chunk;
  text: string;
  definesTerm?: string;
}

/**
 * Splits a chunk so every definition is its own chunk (spec §5.3). Struck text is left alone:
 * it is not current law, so it never defines a term.
 */
function split(chunk: Chunk): Piece[] {
  if (chunk.amendmentStatus === 'deleted')
    return [{ base: chunk, text: chunk.text }];
  const segments = segmentDefinitions(chunk.text);
  const first = segments[0];
  if (!first) return [{ base: chunk, text: chunk.text }];
  const pieces: Piece[] = [];
  const preamble = chunk.text.slice(0, first.start).trim();
  if (preamble) pieces.push({ base: chunk, text: preamble });
  for (const segment of segments) {
    const text = chunk.text.slice(segment.start, segment.end).trim();
    if (text) pieces.push({ base: chunk, text, definesTerm: segment.term });
  }
  return pieces;
}

/**
 * The chunker's overlap can repeat a short definition in the next chunk. Keep one copy,
 * preferring the longer text if one is a truncated version of the other.
 */
function dedupeDefinitionPieces(pieces: Piece[]): Piece[] {
  const kept: Piece[] = [];
  for (const piece of pieces) {
    const same =
      piece.definesTerm === undefined
        ? undefined
        : kept.find(
            (k) =>
              k.definesTerm?.toLowerCase() ===
                piece.definesTerm?.toLowerCase() &&
              k.base.sectionId === piece.base.sectionId &&
              (k.text.includes(piece.text) || piece.text.includes(k.text)),
          );
    if (!same) kept.push(piece);
    else if (piece.text.length > same.text.length) Object.assign(same, piece);
  }
  return kept;
}

/**
 * Runs after chunking: finds definitions, splits definition chunks, resolves cross-references
 * and fills `chunkType`, `definesTerm`, `definedTermsUsed` and `refs`. Pure; inputs are not
 * mutated. Chunk ids are renumbered per section (same `makeChunkId` scheme) because splitting
 * adds chunks.
 */
export function enrichDocument(
  input: NormalizedDoc,
  chunks: readonly Chunk[],
): EnrichedDocument {
  const parsed = NormalizedDoc.safeParse(input);
  if (!parsed.success)
    throw new AppError('INVALID_INPUT', 'Invalid normalized document.');
  const doc = parsed.data;
  const index = buildSectionIndex(doc.sections);
  const definitions = mergeDefinitions(
    doc.definitions,
    extractDefinitions(doc.sections, index),
  );
  const externalRefs = collectExternalRefs(
    doc.sections,
    index,
    doc.externalRefs,
  );
  const termsUsed = createTermMatcher(definitions);

  const pieces = dedupeDefinitionPieces(chunks.flatMap(split));
  const counters = new Map<string, number>();
  const enriched = pieces.map(({ base, text, definesTerm }): Chunk => {
    const n = counters.get(base.sectionId) ?? 0;
    counters.set(base.sectionId, n + 1);
    // Pieces keep their parent's page/line span: the chunker doesn't record offsets within it.
    const { definesTerm: _old, ...rest } = base;
    const embedText = `${base.breadcrumb}: ${text}`;
    const refs = [
      ...new Set([
        ...base.refs,
        ...findInternalRefs(text, base.sectionId, index),
      ]),
    ];
    return Chunk.parse({
      ...rest,
      id: makeChunkId(base.docId, base.sectionId, n),
      text,
      embedText,
      tokenCount: estimateTokens(embedText),
      chunkType: chunkTypeFor(text, base.heading, definesTerm),
      ...(definesTerm === undefined ? {} : { definesTerm }),
      definedTermsUsed: termsUsed(text, base.sectionId, definesTerm),
      refs,
    });
  });
  return { doc: { ...doc, definitions, externalRefs }, chunks: enriched };
}
