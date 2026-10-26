/**
 * Reading-level enforcement (#285): regenerate, never paraphrase.
 *
 * The prompt asks for about a 7th-grade answer (rule 8), but models drift: a live whole-bill
 * summary measured grade 11.1. When an answer grades above the ceiling, we ask the SAME model
 * the SAME question over the SAME context once more, with a stricter plain-language
 * instruction. The new answer goes through the normal pipeline (citations checked against what
 * the model saw, echo guard, excerpt filter), so it is as grounded as any answer.
 *
 * An earlier design rewrote the finished answer with a second model and policed the rewrite
 * with word counts. That kept leaking (swapped values, an appended uncited claim), because a
 * paraphrase of an answer carries no evidence of its own. Regenerating reads the bill again.
 *
 * Skipped, because a plainer retelling could swap old and new wording or say less than the
 * bill: declines, truncated answers, answers to questions about changes, and answers citing
 * struck or inserted text.
 */
import { createHash } from 'node:crypto';
import { envVar } from '../brand.js';
import type {
  AnswerResult,
  AnswerWarning,
  LlmUsage,
  SearchHit,
} from '../model/index.js';
import type { AnswerInput } from './answer.js';
import { coveredSectionIds } from './citations.js';

/**
 * Background and cached outputs (the on-arrival summary) are regenerated above this grade.
 * Nobody is waiting on them, and the result is cached for every reader.
 */
export const DEFAULT_READING_GRADE_MAX = 8;
/**
 * Interactive answers (a question, a chip click) are regenerated only above this higher grade:
 * the reader waits with no sources while the second attempt runs, then the text changes under
 * them, so it is worth that only when the first answer is clearly too hard.
 */
export const DEFAULT_INTERACTIVE_GRADE_MAX = 10;
/** A background regeneration may take this long; past it the first answer is kept. */
export const REGENERATION_TIMEOUT_MS = 30_000;
/** An interactive one is shorter: a reader is watching. */
export const INTERACTIVE_REGENERATION_TIMEOUT_MS = 20_000;

/**
 * The ceiling: `${BRAND}_READING_GRADE_MAX`. `0` disables enforcement. Anything that is not a
 * non-negative number keeps the default, so a typo cannot silently turn the check off.
 */
export function readingGradeCeiling(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return ceilingFromEnv('READING_GRADE_MAX', DEFAULT_READING_GRADE_MAX, env);
}

function ceilingFromEnv(
  suffix: string,
  fallback: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[envVar(suffix)]?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return fallback;
  return Number(raw);
}

/** The interactive ceiling: `${BRAND}_READING_GRADE_MAX_INTERACTIVE`. `0` disables it. */
export function interactiveReadingGradeCeiling(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return ceilingFromEnv(
    'READING_GRADE_MAX_INTERACTIVE',
    DEFAULT_INTERACTIVE_GRADE_MAX,
    env,
  );
}

export interface ReadingLevelOptions {
  /**
   * The output is produced in the background and cached (the on-arrival summary): use the
   * normal ceiling and the longer timeout. Otherwise it is interactive.
   */
  background?: boolean | undefined;
  /** Grade ceiling override. Default: the background or the interactive ceiling. 0 disables. */
  maxGrade?: number | undefined;
  /** Override the timeout. Default: 30 s in the background, 20 s interactive. */
  timeoutMs?: number | undefined;
}

/**
 * Trusted text appended to the question's own instruction. It asks for more than the system
 * prompt does (6th grade, not 7th) because the second try only happens after a miss.
 */
export const PLAIN_LANGUAGE_INSTRUCTION =
  'Write this answer again for a 6th-grade reader. Use short sentences (most under 12 words), one idea each, and everyday words. Keep every number, amount, date, deadline and condition exactly as the bill states it, including words like "not", "unless" and "except". Keep a citation after every claim.';

/** Changes with the regeneration instruction, so cached text from the old rule can be told apart. */
export const REGENERATION_VERSION = createHash('sha256')
  .update(PLAIN_LANGUAGE_INSTRUCTION)
  .digest('hex')
  .slice(0, 12);

export type RegenerationRefusal =
  | 'DECLINED'
  | 'NO_CITATION'
  | 'DROPPED_SECTION'
  | 'NEW_WARNING'
  | 'NOT_SIMPLER'
  | 'TIMEOUT';

/** Warnings the first answer did not have make the second one worse, whatever its grade. */
const WORSE_WARNINGS: readonly AnswerWarning[] = [
  'NO_VALID_CITATIONS',
  'INVALID_CITATIONS_REMOVED',
  'TRUNCATED',
];

/**
 * Whether a plainer retelling could swap old and new wording: the answer cites a section whose
 * text is struck or inserted. (Questions and chips about changes are excluded by the caller.)
 */
export function citesAmendedText(
  result: Pick<AnswerResult, 'citations'>,
  hits: readonly SearchHit[],
): boolean {
  const cited = new Set(
    result.citations.filter((c) => c.valid).map((c) => c.sectionId),
  );
  return hits.some(
    (hit) =>
      coveredSectionIds(hit.chunk).some((id) => cited.has(id)) &&
      (hit.chunk.amendmentStatus !== 'unchanged' ||
        /\[(?:struck|inserted)\]/.test(hit.chunk.text)),
  );
}

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const cacheRead = sum(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWrite = sum(a.cacheWriteTokens, b.cacheWriteTokens);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
    ...(cacheWrite !== undefined && { cacheWriteTokens: cacheWrite }),
  };
}

/** Why `second` may not replace `first`, or null when it may. Pure. */
export function refuseRegeneration(
  first: AnswerResult,
  second: AnswerResult,
): RegenerationRefusal | null {
  if (second.declined && !first.declined) return 'DECLINED';
  if (!second.citations.some((c) => c.valid)) return 'NO_CITATION';
  // A plainer answer must still rest on every section the first one did: dropping a section
  // drops what it said (an "unless" clause, an exception). Covering more is fine. The first
  // answer is cached for every reader, so a thinner second one must not replace it.
  const covered = new Set(
    second.citations.filter((c) => c.valid).map((c) => c.sectionId),
  );
  if (first.citations.some((c) => c.valid && !covered.has(c.sectionId)))
    return 'DROPPED_SECTION';
  if (
    second.warnings.some(
      (w) => WORSE_WARNINGS.includes(w) && !first.warnings.includes(w),
    )
  )
    return 'NEW_WARNING';
  if (
    second.readingGrade === null ||
    first.readingGrade === null ||
    second.readingGrade >= first.readingGrade
  )
    return 'NOT_SIMPLER';
  return null;
}

/**
 * Regenerate `first` if it reads above the ceiling and is not exempt. `run` is the plain
 * answer function (injected so this file does not import `answer.ts` at run time). Never
 * throws for a provider failure or a timeout; an abort by the caller is rethrown. The tokens of
 * a refused second try are still added to `usage`: they were spent.
 */
export async function regenerateForReadingLevel(
  first: AnswerResult,
  input: AnswerInput,
  run: (input: AnswerInput) => Promise<AnswerResult>,
): Promise<AnswerResult> {
  const options = input.readingLevel;
  if (!options) return first;
  const ceiling =
    options.maxGrade ??
    (options.background
      ? readingGradeCeiling()
      : interactiveReadingGradeCeiling());
  if (
    ceiling <= 0 ||
    first.readingGrade === null ||
    first.readingGrade <= ceiling ||
    first.declined ||
    first.simplified === true ||
    first.warnings.includes('TRUNCATED') ||
    input.exactWording === true ||
    citesAmendedText(first, [
      ...input.context.hits,
      ...(input.context.definitions ?? []),
    ])
  )
    return first;
  input.signal?.throwIfAborted();

  const timeout = AbortSignal.timeout(
    options.timeoutMs ??
      (options.background
        ? REGENERATION_TIMEOUT_MS
        : INTERACTIVE_REGENERATION_TIMEOUT_MS),
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  let second: AnswerResult;
  try {
    second = await run({
      ...input,
      chipInstruction: [input.chipInstruction, PLAIN_LANGUAGE_INSTRUCTION]
        .filter(Boolean)
        .join(' '),
      // The reader already saw the first answer stream; the second is not streamed.
      onToken: undefined,
      readingLevel: undefined,
      signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    // No usage to add here: a provider that fails or is aborted mid-stream returns an error,
    // not a `done` event. Providers generally still bill the input of an aborted call, so the
    // cost is unknown to us (#320).
    input.log?.({
      event: 'regeneration_refused',
      reason: timeout.aborted ? 'TIMEOUT' : 'ERROR',
    });
    return first;
  }

  const usage = addUsage(first.usage, second.usage);
  const refusal = refuseRegeneration(first, second);
  if (refusal) {
    input.log?.({ event: 'regeneration_refused', reason: refusal });
    return { ...first, usage };
  }
  return { ...second, usage, simplified: true };
}
