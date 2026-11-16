import { mergeContext } from '../answer/prompt.js';
import { AppError } from '../model/index.js';
import { generateScenario, type ScenarioInput } from './generate.js';
import { validateScenario, type ScenarioValidation } from './validate.js';

export { generateScenario, type ScenarioInput } from './generate.js';
export { validateScenario, type ScenarioValidation } from './validate.js';

export interface CreateScenarioOptions {
  /**
   * Bounds each attempt separately. A retry follows a rejected reply, so a budget shared by both
   * attempts left the retry almost no time: it was cut off, and a cut-off call may still be
   * billed (#408). The caller's own signal still ends every attempt at once.
   */
  attemptTimeoutMs?: number | undefined;
}

/** At most one fresh generation after rejected output; provider failures still propagate. */
export async function createScenario(
  input: ScenarioInput,
  options: CreateScenarioOptions = {},
): Promise<ScenarioValidation> {
  const excerpts = mergeContext(input.excerpts);
  let result: ScenarioValidation = { dropped: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.signal?.aborted)
      throw new DOMException('The operation was aborted.', 'AbortError');
    try {
      const scenario = await generateScenario({
        ...input,
        excerpts,
        signal: attemptSignal(input.signal, options.attemptTimeoutMs),
      });
      result = validateScenario(scenario, excerpts);
      if (result.scenario) return result;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'PROVIDER_BAD_OUTPUT')
        throw error;
      result = { dropped: [{ frameIndex: -1, reason: 'schema' }] };
    }
  }
  return result;
}

function attemptSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
