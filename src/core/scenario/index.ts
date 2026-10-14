import { mergeContext } from '../answer/prompt.js';
import { AppError } from '../model/index.js';
import { generateScenario, type ScenarioInput } from './generate.js';
import { validateScenario, type ScenarioValidation } from './validate.js';

export { generateScenario, type ScenarioInput } from './generate.js';
export { validateScenario, type ScenarioValidation } from './validate.js';

/** At most one fresh generation after rejected output; provider failures still propagate. */
export async function createScenario(
  input: ScenarioInput,
): Promise<ScenarioValidation> {
  const excerpts = mergeContext(input.excerpts);
  let result: ScenarioValidation = { dropped: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (input.signal?.aborted)
      throw new DOMException('The operation was aborted.', 'AbortError');
    try {
      const scenario = await generateScenario({ ...input, excerpts });
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
