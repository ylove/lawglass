/**
 * Model routing (ADR 0018, section 7). The host's `modelFor` picks models per job; the choice
 * rides in the job scope, and this runtime reads it whenever any service asks for a provider.
 * Services keep calling `runtime.answerProvider`, so background generation uses the tier the
 * admitted ingest fixed, with no change to the services.
 */
import type { CliRuntime } from '../cli/runtime.js';
import { currentJob } from '../core/cost/index.js';
import type { LlmProvider } from '../core/model/index.js';

export function routedRuntime(runtime: CliRuntime): CliRuntime {
  const built = new Map<string, LlmProvider>();
  const forModel = (role: 'answer' | 'extract', model: string): LlmProvider => {
    const key = `${role}\n${model}`;
    let provider = built.get(key);
    if (!provider) {
      provider = runtime.providerFor(role, model);
      built.set(key, provider);
    }
    return provider;
  };
  return Object.create(runtime, {
    answerProvider: {
      enumerable: true,
      get(): LlmProvider {
        const model = currentJob()?.models?.answer;
        return model ? forModel('answer', model) : runtime.answerProvider;
      },
    },
    extractProvider: {
      enumerable: true,
      get(): LlmProvider {
        const model = currentJob()?.models?.extract;
        return model ? forModel('extract', model) : runtime.extractProvider;
      },
    },
  }) as CliRuntime;
}
