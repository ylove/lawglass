/**
 * Shared types and small helpers for the chip executors (chip-runner.ts, chip-summary.ts,
 * chip-changes.ts).
 */
import type {
  AnswerResult,
  BackendUsage,
  BillHistory,
  BillMetadata,
  Citation,
  Definition,
  ScanStatus,
  LlmProvider,
  RetrievalBackend,
  RetrievalMode,
  SearchHit,
  Section,
  StoredChunk,
} from './model/index.js';

/** What `runChip` needs to know about the document besides its chunks. */
export interface ChipDoc {
  metadata: BillMetadata;
  /** The section tree, read by `summary` (outline) and `what-changes` (struck/underlined spans). */
  sections: readonly Section[];
  /** When given, `definitions` lists document-wide definitions before section-limited ones. */
  definitions?: readonly Definition[] | undefined;
  /** The stored official record, read by `history`. Absent when none was fetched. */
  history?: BillHistory | undefined;
  /** Per-page read quality for scanned PDFs; `what-changes` will not claim "no changes" on a doubtful one. */
  scan?: ScanStatus | undefined;
}

export interface ChipDeps {
  backend: RetrievalBackend;
  provider: LlmProvider;
  doc: ChipDoc;
}

export interface RunChipOptions {
  signal?: AbortSignal | undefined;
  /** Streamed pieces of the final answer (map-step text is not streamed). */
  onToken?: ((text: string) => void) | undefined;
  maxTokens?: number | undefined;
}

export interface ChipRun {
  answer: AnswerResult;
  /** The excerpts the model was shown, best first. Empty for `sponsors`. */
  hits: SearchHit[];
  /** The retrieval mode actually used; `none` for chips that do not search (summary, what-changes, sponsors). */
  mode: RetrievalMode | 'none';
  /** Embedding and rerank usage for retrieval (LLM usage is inside `answer.usage`). */
  backendUsage: BackendUsage;
}

// ---------------------------------------------------------------------------------------------
// Synthetic excerpts
//
// Some chips show the model text that is not one stored chunk: an outline, the struck runs of a
// section, a partial summary. These are built as `StoredChunk`s so the normal prompt and
// citation machinery applies. Their ids start with `${docId}:~`, which no real chunk id does
// (those are `${docId}:${sectionId}:${n}`), so they can be told apart afterwards.
// ---------------------------------------------------------------------------------------------

export interface SyntheticChunkFields {
  /** Unique within one run, e.g. `outline:3`. */
  key: string;
  /** The section the excerpt is cited as, or a stand-in id that must NOT be citable. */
  sectionId: string;
  /** Real section ids a citation may name for this excerpt. Defaults to just `sectionId`. */
  coveredSectionIds?: readonly string[] | undefined;
  breadcrumb: string;
  text: string;
  amendmentStatus?: StoredChunk['amendmentStatus'];
  location?: Pick<
    StoredChunk,
    'pageStart' | 'pageEnd' | 'lineStart' | 'lineEnd'
  >;
}

export function syntheticHit(
  docId: string,
  f: SyntheticChunkFields,
): SearchHit {
  const [first, ...rest] = f.coveredSectionIds ?? [f.sectionId];
  const chunk: StoredChunk = {
    ...f.location,
    id: `${docId}:~${f.key}`,
    docId,
    sectionId: f.sectionId,
    breadcrumb: f.breadcrumb,
    chunkType: 'other',
    amendmentStatus: f.amendmentStatus ?? 'unchanged',
    text: f.text,
    definedTermsUsed: [],
    refs: [],
    tokenCount: Math.ceil(f.text.length / 4),
  };
  if (first !== undefined) chunk.coveredSectionIds = [first, ...rest];
  return { chunk, score: 1 };
}

/** Citations should point at stored chunks only, so drop the ids of synthetic excerpts. */
export function withoutSyntheticChunks(
  citation: Citation,
  docId: string,
): Citation {
  const prefix = `${docId}:~`;
  return {
    ...citation,
    chunkIds: citation.chunkIds.filter((id) => !id.startsWith(prefix)),
  };
}

/** Append a plain sentence the code (not the model) wants the reader to see, e.g. "3 more ...". */
export function appendNote(
  result: AnswerResult,
  note: string,
  onToken: ((text: string) => void) | undefined,
): AnswerResult {
  if (result.declined || note === '') return result;
  onToken?.(`\n\n${note}`);
  return { ...result, text: `${result.text}\n\n${note}` };
}

/** Hits that are stored chunks, i.e. without the synthetic excerpts built for a prompt. */
export function realHits(
  hits: readonly SearchHit[],
  docId: string,
): SearchHit[] {
  const prefix = `${docId}:~`;
  return hits.filter((h) => !h.chunk.id.startsWith(prefix));
}
