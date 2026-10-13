/**
 * Eval contracts: golden question sets and result rows (spec §8).
 * Golden sets are frozen before the first run (`frozenAtCommit`) and never tuned to make a mode win.
 */
import { z } from 'zod';

export const QuestionKind = z.enum([
  /** Quotes or names an exact citation/term: sparse should do well. */
  'exact',
  /** Concept asked in different words than the text: dense should do well. */
  'paraphrase',
  /** Needs a defined term's definition to answer. */
  'definition',
  /** Asks what the bill removes/strikes (deleted spans). */
  'removed',
  /** Not addressed by the document: the answer must decline. */
  'unanswerable',
]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const GoldenQuestion = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    kind: QuestionKind,
    /** Section ids that contain the answer. Empty only for `unanswerable`. */
    expectedSectionIds: z.array(z.string()),
    notes: z.string().optional(),
  })
  .refine(
    (q) => (q.kind === 'unanswerable') === (q.expectedSectionIds.length === 0),
    {
      message:
        'unanswerable questions must have no expected sections; all others need at least one',
    },
  );
export type GoldenQuestion = z.infer<typeof GoldenQuestion>;

export const GoldenSet = z.object({
  /** Fixture name from fixtures/manifest.json (or `synthetic-*` for CI). */
  fixture: z.string().min(1),
  /** Commit at which the set was frozen; null while drafting. */
  frozenAtCommit: z.string().nullable(),
  questions: z.array(GoldenQuestion).min(1),
});
export type GoldenSet = z.infer<typeof GoldenSet>;

export const RetrievalMetrics = z.object({
  recallAt5: z.number(),
  recallAt10: z.number(),
  mrr: z.number(),
  p50LatencyMs: z.number(),
  embedTokens: z.number(),
  rerankUnits: z.number(),
});
export type RetrievalMetrics = z.infer<typeof RetrievalMetrics>;

export const AnswerMetrics = z.object({
  /** Share of citations that point into the retrieved set. */
  citationValidity: z.number(),
  /** Share of unanswerable questions correctly declined. */
  declineRate: z.number(),
  /** Share of answers that quote struck (deleted) text as current law. */
  deletedLeakageRate: z.number(),
  meanReadingGrade: z.number().nullable(),
  /** Answers above grade 9. */
  answersAboveGrade9: z.number().int(),
});
export type AnswerMetrics = z.infer<typeof AnswerMetrics>;

export const EvalRow = z.object({
  fixture: z.string(),
  backend: z.enum(['pinecone', 'local']),
  mode: z.enum(['dense', 'sparse', 'hybrid', 'hybrid_rerank']),
  fusion: z.enum(['rrf', 'weighted']).optional(),
  retrieval: RetrievalMetrics,
  /** Present only when answers were generated (needs a live provider). */
  answers: AnswerMetrics.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});
export type EvalRow = z.infer<typeof EvalRow>;

export const EvalRun = z.object({
  runAt: z.iso.datetime(),
  commit: z.string(),
  goldenFrozenAtCommit: z.string().nullable(),
  rows: z.array(EvalRow),
});
export type EvalRun = z.infer<typeof EvalRun>;
