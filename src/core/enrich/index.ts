import { contextualText, estimateTokens } from '../chunk/index.js';
import {
  Chunk,
  NormalizedDoc,
  AppError,
  makeChunkId,
  sectionText,
} from '../model/index.js';
import { chunkTypeFor } from './chunk-type.js';
import {
  createTermMatcher,
  extractDefinitions,
  mergeDefinitions,
  segmentDefinitions,
} from './definitions.js';
import { detectAmends } from './amends.js';
import { collectExternalRefs, findInternalRefs } from './refs.js';
import { buildSectionIndex, type SectionIndex } from './section-index.js';

export { chunkTypeFor } from './chunk-type.js';
export {
  createTermMatcher,
  extractDefinitions,
  segmentDefinitions,
} from './definitions.js';
export * from './metadata.js';
export {
  collectExternalRefs,
  findExternalMatches,
  findInternalRefs,
} from './refs.js';
export { detectAmends } from './amends.js';
export { buildSectionIndex } from './section-index.js';

export interface EnrichedDocument {
  /** The input document with `definitions` and `externalRefs` filled in. */
  doc: NormalizedDoc;
  chunks: Chunk[];
}

interface Piece {
  base: Chunk;
  text: string;
  /** Offsets of the (trimmed) text within `base.text`. */
  start: number;
  end: number;
  definesTerm?: string;
  /** Text that follows a definition in the same chunk, so the heading no longer describes it. */
  afterDefinition?: boolean;
}

function piece(
  base: Chunk,
  start: number,
  end: number,
  extra: Partial<Piece> = {},
): Piece | undefined {
  const raw = base.text.slice(start, end);
  const text = raw.trim();
  if (!text) return undefined;
  const from = start + (raw.length - raw.trimStart().length);
  return { base, text, start: from, end: from + text.length, ...extra };
}

/**
 * Splits a chunk so every definition is its own chunk (spec §5.3). Text before, between and
 * after definitions stays in plain pieces. Struck text is left alone: it is not current law,
 * so it never defines a term.
 */
function split(chunk: Chunk): Piece[] {
  const whole = piece(chunk, 0, chunk.text.length) ?? {
    base: chunk,
    text: chunk.text,
    start: 0,
    end: chunk.text.length,
  };
  if (chunk.amendmentStatus === 'deleted') return [whole];
  const segments = segmentDefinitions(chunk.text);
  if (segments.length === 0) return [whole];
  const pieces: Piece[] = [];
  let cursor = 0;
  let seenDefinition = false;
  const push = (p: Piece | undefined): void => {
    if (p) pieces.push(p);
  };
  for (const segment of segments) {
    push(
      piece(chunk, cursor, segment.start, {
        afterDefinition: seenDefinition,
      }),
    );
    push(
      piece(chunk, segment.start, segment.end, { definesTerm: segment.term }),
    );
    seenDefinition = true;
    cursor = segment.end;
  }
  push(piece(chunk, cursor, chunk.text.length, { afterDefinition: true }));
  return pieces;
}

/**
 * Which of a merged chunk's sections have text inside `[start, end)` of the chunk. Merged
 * children are laid out in order, each as its label and then its text, so each is located by
 * its opening words. `sectionId` itself always stays. When a child cannot be located (the
 * chunk window starts inside it) it is kept rather than dropped: citing it stays valid.
 */
function coveredFor(
  chunk: Chunk,
  index: SectionIndex,
  start: number,
  end: number,
): [string, ...string[]] | undefined {
  const covered = chunk.coveredSectionIds;
  if (!covered) return undefined;
  const kept: string[] = [chunk.sectionId];
  let cursor = 0;
  for (const id of covered) {
    if (id === chunk.sectionId) continue;
    const section = index.byId.get(id);
    const body = section ? sectionText(section, { includeDeleted: false }) : '';
    const head = body.trim().slice(0, 40);
    const at = head ? chunk.text.indexOf(head, cursor) : -1;
    if (at === -1) {
      kept.push(id);
      continue;
    }
    const finish = at + body.trim().length;
    cursor = at;
    if (at < end && finish > start) kept.push(id);
  }
  return kept as [string, ...string[]];
}

/**
 * The chunker's overlap can repeat a short definition in the next chunk. Keep one copy,
 * preferring the longer text if one is a truncated version of the other.
 */
function dedupeDefinitionPieces(pieces: Piece[]): Piece[] {
  const kept: Piece[] = [];
  const byKey = new Map<string, Piece[]>();
  for (const piece of pieces) {
    if (piece.definesTerm === undefined) {
      kept.push(piece);
      continue;
    }
    const key = `${piece.base.sectionId}\u0000${piece.definesTerm.toLowerCase()}`;
    const group = byKey.get(key) ?? [];
    const same = group.find(
      (k) => k.text.includes(piece.text) || piece.text.includes(k.text),
    );
    if (!same) {
      kept.push(piece);
      group.push(piece);
      byKey.set(key, group);
    } else if (piece.text.length > same.text.length) Object.assign(same, piece);
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
    { jurisdiction: doc.metadata.jurisdiction },
  );
  const amends =
    doc.metadata.amends ?? detectAmends(doc.sections, doc.metadata);
  const termsUsed = createTermMatcher(definitions);

  const pieces = dedupeDefinitionPieces(chunks.flatMap(split));
  const counters = new Map<string, number>();
  const enriched = pieces.map((p): Chunk => {
    const { base, text, definesTerm } = p;
    const n = counters.get(base.sectionId) ?? 0;
    counters.set(base.sectionId, n + 1);
    // Pieces keep their parent's page/line span: the chunker doesn't record offsets within it.
    const { definesTerm: _old, coveredSectionIds: _covered, ...rest } = base;
    const covered = coveredFor(base, index, p.start, p.end);
    const embedText = contextualText({ breadcrumb: base.breadcrumb, text });
    // Cross-references only: sections already covered by this very chunk are not refs.
    const refs = findInternalRefs(text, base.sectionId, index).filter(
      (id) => !(covered ?? [base.sectionId]).includes(id),
    );
    return Chunk.parse({
      ...rest,
      id: makeChunkId(base.docId, base.sectionId, n),
      text,
      embedText,
      tokenCount: estimateTokens(embedText),
      ...(covered === undefined ? {} : { coveredSectionIds: covered }),
      chunkType: chunkTypeFor(
        text,
        p.afterDefinition ? undefined : base.heading,
        definesTerm,
      ),
      ...(definesTerm === undefined ? {} : { definesTerm }),
      definedTermsUsed: termsUsed(text, base.sectionId, definesTerm),
      refs,
    });
  });
  const metadata =
    amends === undefined ? doc.metadata : { ...doc.metadata, amends };
  return {
    doc: { ...doc, metadata, definitions, externalRefs },
    chunks: enriched,
  };
}
