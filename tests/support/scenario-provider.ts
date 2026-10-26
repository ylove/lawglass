/**
 * Wraps a provider so `generateObject('scenario')` returns a valid, grounded scenario built
 * from the prompt it was given: the persona the app chose and the first excerpt's section.
 * Counts scenario calls so tests can assert when generation did, or did not, happen.
 */
import type {
  LlmProvider,
  ObjectRequest,
  Scenario,
} from '../../src/core/model/index.js';
import { messageText } from '../../src/core/model/index.js';
import { exampleScenario } from '../synth/scenario.js';

export interface ScenarioProvider extends LlmProvider {
  scenarioCalls: number;
  /** Prompts of every scenario generation. */
  prompts: string[];
  /** Called at the start of each scenario generation. */
  onScenario?: () => void;
  /** Replace the default behaviour, e.g. to throw or hang. */
  behavior?: (req: ObjectRequest<unknown>) => Promise<never>;
}

export function scenarioProvider(base: LlmProvider): ScenarioProvider {
  const provider: ScenarioProvider = {
    id: base.id,
    model: base.model,
    scenarioCalls: 0,
    prompts: [],
    streamText: (req) => base.streamText(req),
    generateObject: <T>(req: ObjectRequest<T>) => {
      if (req.schemaName !== 'scenario') return base.generateObject(req);
      provider.scenarioCalls++;
      provider.prompts.push(messageText(req.prompt));
      provider.onScenario?.();
      if (provider.behavior) return provider.behavior(req);
      const name =
        /<persona>([^<]+)<\/persona>/.exec(messageText(req.prompt))?.[1] ??
        'Alex';
      const section =
        /section="([^"]+)"/.exec(messageText(req.prompt))?.[1] ?? 'sec-1';
      const scenario: Scenario = exampleScenario(name);
      for (const frame of scenario.frames)
        if (frame.kind !== 'setup') frame.citations = [section];
      return Promise.resolve({
        object: scenario as T,
        usage: { inputTokens: 5, outputTokens: 7 },
      });
    },
  };
  return provider;
}
