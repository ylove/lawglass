/**
 * Eval metric math. Everything here is a small pure function over plain numbers and strings,
 * so each definition can be read (and unit-tested) in isolation from the retrieval stack.
 *
 * Convention for empty input: a metric with no data to average returns 0, never NaN, so a
 * result row always serializes. Callers decide whether an empty denominator is worth showing.
 */
import type { QuestionKind } from '../core/model/index.js';

// ---------------------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------------------

/**
 * Whether a retrieved section id matches an expected one. A hit counts when the ids are equal,
 * or one is an ancestor of the other: the section tree is a path ("sec-4/b/2"), so a chunk of
 * "sec-4/b" contains the expected "sec-4/b/2", and a chunk of "sec-4/b/2/A" is part of it.
 * Matching on a whole path segment keeps "sec-1" from matching "sec-10".
 */
export function sectionsMatch(retrieved: string, expected: string): boolean {
  return (
    retrieved === expected ||
    retrieved.startsWith(`${expected}/`) ||
    expected.startsWith(`${retrieved}/`)
  );
}

/** Section ids a ranked hit stands for: the merged-sibling list when present, else its own. */
export function hitSectionIds(hit: {
  sectionId: string;
  coveredSectionIds?: readonly string[] | undefined;
}): readonly string[] {
  return hit.coveredSectionIds ?? [hit.sectionId];
}

export interface RankedHit {
  sectionId: string;
  coveredSectionIds?: readonly string[] | undefined;
}

function hitMatches(hit: RankedHit, expected: string): boolean {
  return hitSectionIds(hit).some((id) => sectionsMatch(id, expected));
}

/**
 * Recall@k for one question: the share of expected sections found in the top `k` hits.
 * `hits` must already be in rank order and must exclude injected definitions.
 */
export function recallAtK(
  hits: readonly RankedHit[],
  expectedSectionIds: readonly string[],
  k: number,
): number {
  if (expectedSectionIds.length === 0) return 0;
  const top = hits.slice(0, k);
  const found = expectedSectionIds.filter((expected) =>
    top.some((hit) => hitMatches(hit, expected)),
  );
  return found.length / expectedSectionIds.length;
}

/** Reciprocal rank for one question: 1 / (rank of the first matching hit), or 0 if none match. */
export function reciprocalRank(
  hits: readonly RankedHit[],
  expectedSectionIds: readonly string[],
): number {
  const index = hits.findIndex((hit) =>
    expectedSectionIds.some((expected) => hitMatches(hit, expected)),
  );
  return index === -1 ? 0 : 1 / (index + 1);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The p-th percentile (0-100) by linear interpolation between the two nearest ranks, so p50 of
 * an even-sized sample is the average of the two middle values.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (Math.min(Math.max(p, 0), 100) / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

export const p50 = (values: readonly number[]): number =>
  percentile(values, 50);

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

/** What eval keeps from one generated answer. */
export interface AnswerOutcome {
  kind: QuestionKind;
  text: string;
  declined: boolean;
  /** Citations that point into the retrieved set. */
  validCitations: number;
  /** Citations the validator had to remove because they pointed outside it. */
  invalidCitations: number;
  readingGrade: number | null;
}

/**
 * Share of cited sections that were in the retrieved set. Counts every citation the model
 * wrote, so a hallucinated source lowers it even though the validator removes it from the
 * shown text. No citations at all gives 0: nothing was demonstrated to be valid.
 */
export function citationValidity(outcomes: readonly AnswerOutcome[]): number {
  const valid = outcomes.reduce((n, o) => n + o.validCitations, 0);
  const invalid = outcomes.reduce((n, o) => n + o.invalidCitations, 0);
  return valid + invalid === 0 ? 0 : valid / (valid + invalid);
}

/** Share of `unanswerable` questions whose answer was the decline sentence. */
export function declineRate(outcomes: readonly AnswerOutcome[]): number {
  const unanswerable = outcomes.filter((o) => o.kind === 'unanswerable');
  if (unanswerable.length === 0) return 0;
  return unanswerable.filter((o) => o.declined).length / unanswerable.length;
}

/** Lowercase, drop punctuation and collapse whitespace, so formatting cannot hide a copy. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shortest struck span that counts: shorter ones ("five dollars") collide with live text. */
export const MIN_LEAK_WORDS = 4;

/**
 * Struck spans (at least four words) that appear verbatim in `answerText`. A match means the
 * model repeated deleted text, which is no longer law, as if it were current.
 */
export function findLeakedSpans(
  answerText: string,
  struckSpans: readonly string[],
): string[] {
  const haystack = ` ${normalizeForMatch(answerText)} `;
  return struckSpans.filter((span) => {
    const needle = normalizeForMatch(span);
    return (
      needle.split(' ').length >= MIN_LEAK_WORDS &&
      haystack.includes(` ${needle} `)
    );
  });
}

/**
 * Share of answers to non-`removed` questions that leak struck text. Questions about removal
 * are excluded because quoting deleted text is the right answer to them.
 */
export function deletedLeakageRate(
  outcomes: readonly AnswerOutcome[],
  struckSpans: readonly string[],
): number {
  const scored = outcomes.filter((o) => o.kind !== 'removed');
  if (scored.length === 0) return 0;
  const leaking = scored.filter(
    (o) => findLeakedSpans(o.text, struckSpans).length > 0,
  );
  return leaking.length / scored.length;
}

/** Words that signal an answer is talking about removal rather than describing current law. */
const REMOVAL_LANGUAGE =
  /\b(?:remov\w*|struck|strik\w*|delet\w*|repeal\w*|eliminat\w*|no longer|omitted)\b/i;

/** Share of `removed` answers that say the text was removed (the spec asks eval to check this). */
export function removalAcknowledgedRate(
  outcomes: readonly AnswerOutcome[],
): number {
  const removed = outcomes.filter((o) => o.kind === 'removed' && !o.declined);
  const asked = outcomes.filter((o) => o.kind === 'removed');
  if (asked.length === 0) return 0;
  return (
    removed.filter((o) => REMOVAL_LANGUAGE.test(o.text)).length / asked.length
  );
}

export interface GradeSummary {
  /** Mean Flesch-Kincaid grade over answers that have one, or null when none do. */
  mean: number | null;
  /** Answers graded above grade 9 (the readability target). */
  above9: number;
}

export const GRADE_TARGET = 9;

/** Aggregate reading grades. Answers with no gradable words (null) are left out of both. */
export function summarizeGrades(
  grades: readonly (number | null)[],
): GradeSummary {
  const graded = grades.filter((g): g is number => g !== null);
  return {
    mean: graded.length === 0 ? null : mean(graded),
    above9: graded.filter((g) => g > GRADE_TARGET).length,
  };
}
