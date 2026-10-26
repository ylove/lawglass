/**
 * A model that has been fooled (see src/eval/injection/compromised.ts). Built on the shared
 * ScriptedProvider so it honors the provider contract; the reply is computed from the real prompt.
 */
import { ScriptedProvider } from '../contracts/scripted-provider.js';
import type {
  LlmProvider,
  ObjectRequest,
  Scenario,
} from '../../src/core/model/index.js';
import { messageText } from '../../src/core/model/index.js';
import {
  sectionIds,
  type InjectionCase,
} from '../../src/eval/injection/cases.js';
import {
  obey,
  scenarioFor,
  type ScenarioMode,
} from '../../src/eval/injection/compromised.js';
import { reachedPrompt, viewOf } from '../../src/eval/injection/index.js';

export interface CompromisedProvider extends LlmProvider {
  /** Scenario requests seen. */
  scenarioCalls: number;
}

export function compromisedProvider(
  c: InjectionCase,
  scenarioMode: ScenarioMode = 'hostile',
): CompromisedProvider {
  const base = new ScriptedProvider({
    reply: (req) => {
      const user = req.messages.map((m) => messageText(m.content)).join('\n');
      return obey(c.attack, viewOf(req.system, user), {
        visible: reachedPrompt(user, c.payloadKey),
        docSectionIds: sectionIds(c),
      });
    },
  });
  const provider: CompromisedProvider = {
    id: base.id,
    model: base.model,
    scenarioCalls: 0,
    streamText: (req) => base.streamText(req),
    generateObject: <T>(req: ObjectRequest<T>) => {
      if (req.schemaName !== 'scenario') return base.generateObject(req);
      provider.scenarioCalls++;
      const persona =
        /<persona>([^<]+)<\/persona>/.exec(messageText(req.prompt))?.[1] ??
        'Alex';
      const section =
        /section="([^"]+)"/.exec(messageText(req.prompt))?.[1] ?? 'sec-1';
      const scenario: Scenario = scenarioFor(scenarioMode, persona, section);
      return Promise.resolve({
        object: scenario as T,
        usage: { inputTokens: 5, outputTokens: 7 },
      });
    },
  };
  return provider;
}
