import type { LlmProvider } from '../model/index.js';

/**
 * Defers reading the provider (which throws MISSING_KEY when no key is configured) until it is
 * used, so chips that make no LLM call, like sponsors, work without a key, and chips with an
 * optional model step, like delegations, can fall back to a plain answer.
 */
export function lazyProvider(get: () => LlmProvider): LlmProvider {
  return {
    get id() {
      return get().id;
    },
    get model() {
      return get().model;
    },
    streamText: (req) => get().streamText(req),
    generateObject: (req) => get().generateObject(req),
  };
}
