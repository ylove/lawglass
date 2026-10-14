/** Run-file extensions live here; the shared eval contracts remain frozen. */
import { z } from 'zod';
import {
  EvalRow,
  EvalRun,
  GoldenQuestion,
  SectionId,
} from '../core/model/index.js';
import { hitSectionIds, sectionsMatch } from './metrics.js';

export const EVAL_TOP_K = 10;

export const RetrievalDetailHit = z.object({
  sectionId: SectionId,
  breadcrumb: z.string(),
  score: z.number(),
  // Merged chunks can contain sibling sections that sectionId alone cannot represent.
  coveredSectionIds: z.array(SectionId).nonempty().optional(),
});
export type RetrievalDetailHit = z.infer<typeof RetrievalDetailHit>;

export const QuestionDetail = z.object({
  id: GoldenQuestion.shape.id,
  kind: GoldenQuestion.shape.kind.exclude(['unanswerable']),
  question: GoldenQuestion.shape.question,
  expectedSectionIds: GoldenQuestion.shape.expectedSectionIds.nonempty(),
  firstRelevantRank: z.number().int().min(1).max(EVAL_TOP_K).nullable(),
  top10: z.array(RetrievalDetailHit).max(EVAL_TOP_K),
});
export type QuestionDetail = z.infer<typeof QuestionDetail>;

export const DetailedEvalRow = EvalRow.extend({
  questions: z.array(QuestionDetail),
});
export type DetailedEvalRow = z.infer<typeof DetailedEvalRow>;

export const DetailedEvalRun = EvalRun.extend({
  rows: z.array(DetailedEvalRow),
});
export type DetailedEvalRun = z.infer<typeof DetailedEvalRun>;

export function firstRelevantRank(
  hits: readonly RetrievalDetailHit[],
  expectedSectionIds: readonly string[],
): number | null {
  const index = hits.findIndex((hit) =>
    hitSectionIds(hit).some((id) =>
      expectedSectionIds.some((expected) => sectionsMatch(id, expected)),
    ),
  );
  return index === -1 ? null : index + 1;
}

/** Preserve golden order and chunk rank; unanswerable questions are not retrieval data. */
export function retrievalDetails(
  questions: readonly GoldenQuestion[],
  retrievals: ReadonlyMap<string, { hits: readonly RetrievalDetailHit[] }>,
): QuestionDetail[] {
  return questions.flatMap((q) => {
    const retrieved = retrievals.get(q.id);
    if (q.kind === 'unanswerable' || !retrieved) return [];
    const top10 = retrieved.hits.slice(0, EVAL_TOP_K);
    return [
      {
        id: q.id,
        kind: q.kind,
        question: q.question,
        expectedSectionIds: [...q.expectedSectionIds],
        firstRelevantRank: firstRelevantRank(top10, q.expectedSectionIds),
        top10,
      },
    ];
  });
}
