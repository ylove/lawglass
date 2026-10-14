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

/** Minimum contiguous quotation length; shorter phrases collide too easily with live text. */
export const MIN_LEAK_WORDS = 4;

/** Words that signal an answer is talking about removal rather than describing current law. */
const REMOVAL_LANGUAGE =
  /\b(?:remov\w*|struck|strik\w*|delet\w*|repeal\w*|eliminat\w*|no longer|omitted)\b/i;

/** Keep quoted sentences with their introduction or trailing removal acknowledgement. */
function answerClaims(text: string): string[] {
  const claims: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (char === '“') quoted = true;
    else if (char === '”') quoted = false;
    else if (char === '"') quoted = !quoted;
    if (quoted) continue;
    // A single newline may just wrap a quotation. Paragraphs and list items separate claims.
    const paragraph =
      char === '\n' && /^\s*\n|^\s*[-*]\s/.test(text.slice(i + 1));
    if (/[.!?;]/.test(char) || paragraph) {
      claims.push(text.slice(start, i));
      start = i + 1;
    } else if (i === 0 || /\W/.test(text[i - 1] ?? '')) {
      const conjunction =
        /^(?:but|however|yet|and(?=\s+(?:the|this|it|they|currently|now)\b))\b/i.exec(
          text.slice(i),
        );
      if (conjunction) {
        claims.push(text.slice(start, i));
        start = i + conjunction[0].length;
        i = start - 1;
      }
    }
  }
  claims.push(text.slice(start));
  return claims;
}

function acknowledgesRemoval(context: string): boolean {
  for (const cue of context.matchAll(new RegExp(REMOVAL_LANGUAGE, 'gi'))) {
    const before = context.slice(0, cue.index);
    // "Does not remove" still presents the quoted rule as live law.
    if (!/\b(?:not|never|cannot)\s+(?:\w+\s+){0,2}$/.test(before)) return true;
  }
  return false;
}

/**
 * Deleted runs quoted as current law, including partial quotations of at least four words.
 * A quotation must be absent from live text to be distinctive: the old and replacement fee
 * sentences share most of their words. This is an exact-text heuristic, not a paraphrase judge.
 */
export function findLeakedSpans(
  answerText: string,
  struckSpans: readonly string[],
  liveTexts: readonly string[] = [],
): string[] {
  const claims = answerClaims(answerText).map((claim) =>
    normalizeForMatch(claim).split(' '),
  );
  const live = liveTexts.map((text) => ` ${normalizeForMatch(text)} `);
  return struckSpans.filter((span) => {
    const deleted = normalizeForMatch(span).split(' ');
    for (const words of claims) {
      for (let from = 0; from <= words.length - MIN_LEAK_WORDS; from++) {
        for (
          let source = 0;
          source <= deleted.length - MIN_LEAK_WORDS;
          source++
        ) {
          // Only evaluate maximal matches so a removal verb inside the quotation cannot
          // accidentally become context for one of its shorter subphrases.
          if (from > 0 && source > 0 && words[from - 1] === deleted[source - 1])
            continue;
          let length = 0;
          while (
            from + length < words.length &&
            source + length < deleted.length &&
            words[from + length] === deleted[source + length]
          )
            length++;
          if (length < MIN_LEAK_WORDS) continue;
          const quotation = ` ${words.slice(from, from + length).join(' ')} `;
          if (live.some((text) => text.includes(quotation))) continue;
          const context = [
            ...words.slice(0, from),
            ...words.slice(from + length),
          ].join(' ');
          if (!acknowledgesRemoval(context)) return true;
        }
      }
    }
    return false;
  });
}

/** Share of all answers presenting a distinctive deleted quotation as current law. */
export function deletedLeakageRate(
  outcomes: readonly AnswerOutcome[],
  struckSpans: readonly string[],
  liveTexts: readonly string[] = [],
): number {
  if (outcomes.length === 0) return 0;
  const leaking = outcomes.filter(
    (o) => findLeakedSpans(o.text, struckSpans, liveTexts).length > 0,
  );
  return leaking.length / outcomes.length;
}

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
