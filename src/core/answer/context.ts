/** Whole-bill policy shared by questions, chips, summaries and scenarios. */
import { envVar } from '../brand.js';
import { estimateTokens } from '../chunk/tokens.js';
import {
  AppError,
  makeChunkId,
  sectionText,
  walkSections,
  type RetrievalBackend,
  type SearchHit,
  type Section,
} from '../model/index.js';

export type ContextMode = 'whole' | 'excerpts';
export const WHOLE_BILL_MAX_TOKENS = 100_000;
const LATER_ROUND_IDS = 32;
/** Chunks are at most 450 tokens; a first-round guess sized from the text avoids most extra rounds. */
const CHUNK_TOKENS_GUESS = 250;
const MAX_FIRST_ROUND_IDS = 64;
const PARALLEL_BATCHES = 4;
const FETCH_BATCH_SIZE = 500;

export function wholeBillBudget(): number {
  const raw = process.env[envVar('WHOLE_BILL_MAX_TOKENS')];
  if (raw === undefined || raw.trim() === '') return WHOLE_BILL_MAX_TOKENS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : WHOLE_BILL_MAX_TOKENS;
}

export function contextMode(
  tokens: number,
  budget = wholeBillBudget(),
): ContextMode {
  return budget > 0 && tokens <= budget ? 'whole' : 'excerpts';
}

export function wholeBillEffort(): 'low' | 'medium' | 'high' {
  const value = process.env[envVar('EFFORT')];
  return value === 'low' || value === 'high' ? value : 'medium';
}

/**
 * Chunking and enrichment number records consecutively from zero within each section. Probe
 * those ids instead of searching: a relevance cutoff would silently hide part of the bill.
 * Fetch order is not a backend guarantee, so reconstruct section/ordinal order explicitly.
 *
 * Round trips: the first round probes each section for as many chunks as its text suggests
 * (plus slack), so most bills need one round. A section whose last probed id exists is probed
 * again, further along, until a probe comes back short.
 */
export async function documentHits(
  backend: RetrievalBackend,
  docId: string,
  sections: readonly Section[],
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const ordered = [...walkSections(sections)];
  const found = new Map<string, SearchHit>();
  let active = ordered.map((section) => ({
    section,
    next: 0,
    probe: Math.min(
      MAX_FIRST_ROUND_IDS,
      2 +
        Math.ceil(
          estimatedTokens([{ ...section, children: [] }], true) /
            CHUNK_TOKENS_GUESS,
        ) *
          2,
    ),
  }));
  while (active.length > 0) {
    signal?.throwIfAborted();
    const ids = active.flatMap(({ section, next, probe }) =>
      Array.from({ length: probe }, (_, n) =>
        makeChunkId(docId, section.id, next + n),
      ),
    );
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += FETCH_BATCH_SIZE)
      batches.push(ids.slice(i, i + FETCH_BATCH_SIZE));
    for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
      signal?.throwIfAborted();
      const fetched = await Promise.all(
        batches
          .slice(i, i + PARALLEL_BATCHES)
          .map((batch) => backend.getChunks(docId, batch)),
      );
      for (const chunks of fetched)
        for (const chunk of chunks) found.set(chunk.id, { chunk, score: 1 });
    }
    active = active
      .filter(({ section, next, probe }) =>
        found.has(makeChunkId(docId, section.id, next + probe - 1)),
      )
      .map(({ section, next, probe }) => ({
        section,
        next: next + probe,
        probe: LATER_ROUND_IDS,
      }));
  }
  const hits: SearchHit[] = [];
  for (const section of ordered) {
    for (let n = 0; ; n++) {
      const hit = found.get(makeChunkId(docId, section.id, n));
      if (!hit) break;
      hits.push(hit);
    }
  }
  return dropOverlap(hits);
}

/** The chunker's overlap window (`OVERLAP` in chunk/index.ts): the most tokens it repeats. */
const OVERLAP_TOKENS = 50;

/**
 * The longest whole-word tail of `text` that the chunker would carry into the next chunk: it
 * walks back a word at a time while the tail stays within the overlap window.
 */
function overlapWindow(text: string): string {
  const starts = [...text.matchAll(/\S+/g)].map((m) => m.index);
  let tail = '';
  for (let i = starts.length - 1; i >= 0; i--) {
    const candidate = text.slice(starts[i]);
    if (estimateTokens(candidate) > OVERLAP_TOKENS) break;
    tail = candidate;
  }
  return tail;
}

/**
 * Chunks of one section overlap by design so retrieval does not lose a sentence at a boundary.
 * Reading the whole bill, that overlap would repeat text (and could read as two provisions).
 * The chunker's rule is exact: a chunk starts with the previous chunk's longest tail of at
 * most 50 tokens (shrunk only when the chunk would otherwise overflow). So cut precisely that
 * tail, and only when the chunk really starts with it. Anything else is left alone: repeated
 * wording never shortens the cut, and a chunk whose overlap was shrunk keeps its few repeated
 * words rather than risk dropping real text. Definition and struck chunks are not trimmed.
 * Every chunk, and so every section id, stays present and citable. Token counts shrink in
 * proportion, so the budget decision counts the de-duplicated size.
 */
function dropOverlap(hits: readonly SearchHit[]): SearchHit[] {
  return hits.map((hit, i) => {
    const prev = hits[i - 1]?.chunk;
    const chunk = hit.chunk;
    if (!prev) return hit;
    if (
      prev.sectionId !== chunk.sectionId ||
      prev.amendmentStatus === 'deleted' ||
      chunk.amendmentStatus === 'deleted' ||
      prev.chunkType === 'definition' ||
      chunk.chunkType === 'definition'
    )
      return hit;
    const overlap = overlapWindow(prev.text);
    if (
      overlap === '' ||
      !chunk.text.startsWith(overlap) ||
      !/^\s/.test(chunk.text.slice(overlap.length))
    )
      return hit;
    const text = chunk.text.slice(overlap.length).trimStart();
    return {
      ...hit,
      chunk: {
        ...chunk,
        text,
        tokenCount: Math.max(
          1,
          Math.round((chunk.tokenCount * text.length) / chunk.text.length),
        ),
      },
    };
  });
}

/** A rough token count from the section text alone, with no backend call. */
export function estimatedTokens(
  sections: readonly Section[],
  includeDeleted: boolean,
): number {
  let chars = 0;
  for (const section of walkSections(sections))
    chars += sectionText(section, { includeDeleted }).length;
  return Math.ceil(chars / 4);
}

export interface DocumentContext {
  mode: ContextMode;
  hits: SearchHit[];
}

/**
 * A document id is a content hash, so a complete scan of it never changes: scan once per
 * process and reuse. Memos hang off the real backend object (wrappers point at it with
 * `MEMO_OWNER`), so separate stores never share entries. Bounded by document count and total
 * tokens.
 *
 * A scan is only trusted if it is complete and nothing changed under it:
 * - each document has a generation that `forgetDocument` bumps (delete, ingest). A scan stores
 *   its result only if the generation is the same as when it started, so a scan racing a delete
 *   or a re-index never pins a partial view.
 * - a scan that leaves out a section with text (an empty or half-visible index) is returned to
 *   its caller as "excerpts" and never stored.
 * Concurrent cold requests share one in-flight scan.
 */
export const MEMO_OWNER = Symbol('documentMemoOwner');
const MEMO_MAX_DOCUMENTS = 16;
const MEMO_MAX_TOKENS = 1_000_000;

interface Memo {
  scans: Map<string, SearchHit[]>;
  inflight: Map<string, Promise<SearchHit[] | undefined>>;
  generation: Map<string, number>;
}
const memos = new WeakMap<object, Memo>();

function memoFor(backend: RetrievalBackend): Memo {
  const owner =
    (backend as RetrievalBackend & { [MEMO_OWNER]?: object })[MEMO_OWNER] ??
    backend;
  let memo = memos.get(owner);
  if (!memo)
    memos.set(
      owner,
      (memo = {
        scans: new Map<string, SearchHit[]>(),
        inflight: new Map(),
        generation: new Map(),
      }),
    );
  return memo;
}

const tokensOf = (hits: readonly SearchHit[]): number =>
  hits.reduce((n, h) => n + h.chunk.tokenCount, 0);

/**
 * Forget a document's scan and invalidate any scan in flight. Call it when the document's
 * chunks may have changed: after an ingest and around a delete.
 */
export function forgetDocument(backend: RetrievalBackend, docId: string): void {
  const memo = memoFor(backend);
  memo.generation.set(docId, (memo.generation.get(docId) ?? 0) + 1);
  memo.scans.delete(docId);
  memo.inflight.delete(docId);
}

/** Delete a document's index, forgetting its scan before and after so no scan outlives it. */
export async function deleteIndexedDocument(
  backend: RetrievalBackend,
  docId: string,
): Promise<void> {
  forgetDocument(backend, docId);
  try {
    await backend.deleteDocument(docId);
  } finally {
    forgetDocument(backend, docId);
  }
}

/**
 * True when every section with live text is represented: it has a chunk, or a chunk that
 * covers it (merged sections). An empty or half-visible index fails this.
 */
function coversEverySection(
  hits: readonly SearchHit[],
  sections: readonly Section[],
): boolean {
  const covered = new Set<string>();
  for (const { chunk } of hits)
    for (const id of chunk.coveredSectionIds ?? [chunk.sectionId])
      covered.add(id);
  for (const section of walkSections(sections))
    if (
      !covered.has(section.id) &&
      sectionText(section, { includeDeleted: false }).trim() !== ''
    )
      return false;
  return true;
}

function startScan(
  backend: RetrievalBackend,
  memo: Memo,
  docId: string,
  sections: readonly Section[],
): Promise<SearchHit[] | undefined> {
  const started = memo.generation.get(docId) ?? 0;
  // Not tied to one caller's signal: other requests share this scan. Callers check their own.
  const scan = (async (): Promise<SearchHit[] | undefined> => {
    // The same check the ask path makes, for routes that reach the raw backend.
    if (!(await backend.hasDocument(docId)))
      throw new AppError('DOC_NOT_FOUND', 'The document has no index.', {
        userMessage:
          "This document's search index is missing. Run ingest again for its URL.",
      });
    const hits = await documentHits(backend, docId, sections);
    if (!coversEverySection(hits, sections)) return undefined;
    // A delete or re-ingest ran under the scan: what it read may be half of either version, so
    // nobody, not even the requests waiting on this scan, may treat it as the whole bill.
    if ((memo.generation.get(docId) ?? 0) !== started) return undefined;
    memo.scans.set(docId, hits);
    let total = 0;
    for (const h of memo.scans.values()) total += tokensOf(h);
    for (const key of memo.scans.keys()) {
      if (memo.scans.size <= MEMO_MAX_DOCUMENTS && total <= MEMO_MAX_TOKENS)
        break;
      if (key === docId) continue;
      total -= tokensOf(memo.scans.get(key) ?? []);
      memo.scans.delete(key);
    }
    return hits;
  })();
  memo.inflight.set(docId, scan);
  const clear = (): void => {
    if (memo.inflight.get(docId) === scan) memo.inflight.delete(docId);
  };
  scan.then(clear, clear);
  return scan;
}

/** The document's live scan, or undefined when the index does not (yet) hold all of it. */
async function scanned(
  backend: RetrievalBackend,
  docId: string,
  sections: readonly Section[],
  signal: AbortSignal | undefined,
): Promise<SearchHit[] | undefined> {
  signal?.throwIfAborted();
  const memo = memoFor(backend);
  const known = memo.scans.get(docId);
  if (known) {
    // Re-insert so the Map's order is least recently used first.
    memo.scans.delete(docId);
    memo.scans.set(docId, known);
    return known;
  }
  const hits = await untilAborted(
    memo.inflight.get(docId) ?? startScan(backend, memo, docId, sections),
    signal,
  );
  signal?.throwIfAborted();
  return hits;
}

/**
 * Wait for a shared promise, but stop waiting as soon as this caller's request is cancelled.
 * The shared work keeps running for the others; this caller releases its permit right away.
 */
function untilAborted<T>(
  shared: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return shared;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError'),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function documentContext(
  backend: RetrievalBackend,
  docId: string,
  sections: readonly Section[],
  options: {
    budget?: number | undefined;
    includeDeleted?: boolean;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<DocumentContext> {
  const budget = options.budget ?? wholeBillBudget();
  if (budget === 0) return { mode: 'excerpts', hits: [] };
  // A bill far over budget (the NDAA) must not fetch every chunk on every question just to
  // learn that. Characters / 4 approximates tokens; the margin keeps borderline bills exact.
  if (estimatedTokens(sections, options.includeDeleted === true) > budget * 1.5)
    return { mode: 'excerpts', hits: [] };
  const all = await scanned(backend, docId, sections, options.signal);
  // An incomplete index is not "the whole bill": let retrieval work with what it has.
  if (!all) return { mode: 'excerpts', hits: [] };
  const hits = all.filter(
    (h) =>
      options.includeDeleted === true || h.chunk.amendmentStatus !== 'deleted',
  );
  const mode = contextMode(tokensOf(hits), budget);
  return { mode, hits: mode === 'whole' ? hits : [] };
}
