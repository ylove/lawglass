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
const IDS_PER_SECTION = 16;
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
 */
export async function documentHits(
  backend: RetrievalBackend,
  docId: string,
  sections: readonly Section[],
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const ordered = [...walkSections(sections)];
  const found = new Map<string, SearchHit>();
  let active = ordered;
  for (let offset = 0; active.length > 0; offset += IDS_PER_SECTION) {
    signal?.throwIfAborted();
    const ids = active.flatMap((section) =>
      Array.from({ length: IDS_PER_SECTION }, (_, n) =>
        makeChunkId(docId, section.id, offset + n),
      ),
    );
    for (let i = 0; i < ids.length; i += FETCH_BATCH_SIZE) {
      signal?.throwIfAborted();
      const chunks = await backend.getChunks(
        docId,
        ids.slice(i, i + FETCH_BATCH_SIZE),
      );
      for (const chunk of chunks) found.set(chunk.id, { chunk, score: 1 });
    }
    active = active.filter((s) =>
      found.has(makeChunkId(docId, s.id, offset + IDS_PER_SECTION - 1)),
    );
  }
  const hits: SearchHit[] = [];
  for (const section of ordered) {
    for (let n = 0; ; n++) {
      const hit = found.get(makeChunkId(docId, section.id, n));
      if (!hit) break;
      hits.push(hit);
    }
  }
  return hits;
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
  const hits = (
    await documentHits(backend, docId, sections, options.signal)
  ).filter(
    (h) =>
      options.includeDeleted === true || h.chunk.amendmentStatus !== 'deleted',
  );
  const mode = contextMode(
    hits.reduce((n, h) => n + h.chunk.tokenCount, 0),
    budget,
  );
  return { mode, hits: mode === 'whole' ? hits : [] };
}
