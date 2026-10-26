/** Whole-bill policy shared by questions, chips, summaries and scenarios. */
import { envVar } from '../brand.js';
import {
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

/** Overlap is at most 50 tokens (about 200 characters); look a little further to be safe. */
const MAX_OVERLAP_CHARS = 600;
/** Shorter coincidences are more likely ordinary repeated words than a chunk overlap. */
const MIN_OVERLAP_CHARS = 20;

/**
 * Chunks of one section overlap by design so retrieval does not lose a sentence at a boundary.
 * Reading the whole bill, that overlap would repeat text (and could read as two provisions), so
 * trim the part of each chunk that the previous chunk of the same section already ends with.
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
      (prev.amendmentStatus === 'deleted') !==
        (chunk.amendmentStatus === 'deleted')
    )
      return hit;
    // `prev.text` is the original here: trimming only ever shortens the head of a chunk, and
    // the overlap is a tail of the previous chunk's full text.
    let cut = 0;
    const limit = Math.min(MAX_OVERLAP_CHARS, chunk.text.length - 1);
    for (let k = MIN_OVERLAP_CHARS; k <= limit; k++) {
      if (
        /\s/.test(chunk.text.charAt(k)) &&
        prev.text.endsWith(chunk.text.slice(0, k))
      )
        cut = k;
    }
    if (cut === 0) return hit;
    const text = chunk.text.slice(cut).trimStart();
    if (text.length === 0) return hit;
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
 * A document id is a content hash, so its chunks never change: scan once per process and
 * reuse. Memos hang off the real backend object (wrappers point at it with `MEMO_OWNER`), so
 * separate stores never share entries. Bounded by document count and by total tokens.
 */
export const MEMO_OWNER = Symbol('documentMemoOwner');
const MEMO_MAX_DOCUMENTS = 16;
const MEMO_MAX_TOKENS = 1_000_000;
const memos = new WeakMap<object, Map<string, SearchHit[]>>();

function memoFor(backend: RetrievalBackend): Map<string, SearchHit[]> {
  const owner =
    (backend as RetrievalBackend & { [MEMO_OWNER]?: object })[MEMO_OWNER] ??
    backend;
  let memo = memos.get(owner);
  if (!memo) memos.set(owner, (memo = new Map<string, SearchHit[]>()));
  return memo;
}

const tokensOf = (hits: readonly SearchHit[]): number =>
  hits.reduce((n, h) => n + h.chunk.tokenCount, 0);

/** Forget a document's scan (on removal). Harmless if absent. */
export function forgetDocument(backend: RetrievalBackend, docId: string): void {
  memoFor(backend).delete(docId);
}

async function scanned(
  backend: RetrievalBackend,
  docId: string,
  sections: readonly Section[],
  signal: AbortSignal | undefined,
): Promise<SearchHit[]> {
  const memo = memoFor(backend);
  const known = memo.get(docId);
  if (known) {
    // Re-insert so the Map's order is least recently used first.
    memo.delete(docId);
    memo.set(docId, known);
    return known;
  }
  const hits = await documentHits(backend, docId, sections, signal);
  memo.set(docId, hits);
  let total = 0;
  for (const h of memo.values()) total += tokensOf(h);
  for (const key of memo.keys()) {
    if (memo.size <= MEMO_MAX_DOCUMENTS && total <= MEMO_MAX_TOKENS) break;
    if (key === docId) continue;
    total -= tokensOf(memo.get(key) ?? []);
    memo.delete(key);
  }
  return hits;
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
  const hits = (await scanned(backend, docId, sections, options.signal)).filter(
    (h) =>
      options.includeDeleted === true || h.chunk.amendmentStatus !== 'deleted',
  );
  const mode = contextMode(tokensOf(hits), budget);
  return { mode, hits: mode === 'whole' ? hits : [] };
}
