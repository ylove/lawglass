/**
 * Best-effort scenario attachment for an answer that is already finished.
 *
 * The scenario is generated AFTER the answer text, from the answer's own retrieved excerpts, so
 * it cites the same sections the reader just saw. It is optional decoration: a timeout, a
 * provider error, a dropped scenario or a client disconnect all end in "no scenario", and the
 * answer is never touched. This function therefore never throws.
 */
import {
  type LlmUsage,
  type LlmProvider,
  type ObjectRequest,
  type Scenario,
  type SearchHit,
} from '../model/index.js';
import { createScenario } from './index.js';

/** A story is optional and arrives after `done`, but a hung provider should still be cut off. */
export const SCENARIO_TIMEOUT_MS = 12_000;
/** Excerpts shown to the scenario model; bounds the prompt for chips with many hits. */
export const MAX_SCENARIO_EXCERPTS = 8;

export interface AttachScenarioInput {
  provider: LlmProvider;
  /** Whole mode grounds against every live section, without the excerpt cap. */
  whole?: boolean | undefined;
  /** The excerpts the answer was written from, best first. */
  hits: readonly SearchHit[];
  /**
   * Sections the answer cited. Hits from these sections are shown to the scenario model first, so
   * a summary built from many units still gets a story about what it actually cited.
   */
  citedSectionIds?: readonly string[] | undefined;
  question?: string | undefined;
  /** A reader-requested subject, already vetted; see `ScenarioInput.subject`. */
  subject?: string | undefined;
  docId?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface AttachedScenario {
  scenario?: Scenario;
  /** LLM tokens spent, including a failed or dropped attempt. */
  usage: { inputTokens: number; outputTokens: number };
}

export async function attachScenario(
  input: AttachScenarioInput,
): Promise<AttachedScenario> {
  let usage = { inputTokens: 0, outputTokens: 0 };
  // Count tokens at the provider boundary, since `createScenario` returns only the scenario.
  const counting: LlmProvider = {
    id: input.provider.id,
    model: input.provider.model,
    streamText: (request) => input.provider.streamText(request),
    generateObject: async <T>(request: ObjectRequest<T>) => {
      const result = await input.provider.generateObject(request);
      usage = {
        inputTokens: usage.inputTokens + result.usage.inputTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
      };
      return result;
    },
  };
  const live = input.hits.filter(
    (hit) => hit.chunk.amendmentStatus !== 'deleted',
  );
  const cited = new Set(input.citedSectionIds ?? []);
  const isCited = (hit: SearchHit): boolean =>
    [hit.chunk.sectionId, ...(hit.chunk.coveredSectionIds ?? [])].some((id) =>
      cited.has(id),
    );
  // Cited excerpts first, then the rest in their original (best-first) order, up to the cap.
  const ranked = [
    ...live.filter(isCited),
    ...live.filter((hit) => !isCited(hit)),
  ];
  const hits = input.whole ? live : ranked.slice(0, MAX_SCENARIO_EXCERPTS);
  if (hits.length === 0) return { usage };

  const timeout = AbortSignal.timeout(input.timeoutMs ?? SCENARIO_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  try {
    const { scenario } = await createScenario({
      provider: counting,
      excerpts: hits,
      question: input.question,
      ...(input.subject === undefined
        ? {}
        : { subject: input.subject, docId: input.docId ?? '' }),
      signal,
    });
    return scenario ? { scenario, usage } : { usage };
  } catch {
    // Deliberately silent: the error may carry provider text, and the answer stands without it.
    return { usage };
  }
}

/** Adds scenario tokens to an answer's usage without mutating either. */
export function addScenarioUsage(
  answerUsage: LlmUsage,
  scenarioUsage: { inputTokens: number; outputTokens: number },
): LlmUsage {
  return {
    ...answerUsage,
    inputTokens: answerUsage.inputTokens + scenarioUsage.inputTokens,
    outputTokens: answerUsage.outputTokens + scenarioUsage.outputTokens,
  };
}
