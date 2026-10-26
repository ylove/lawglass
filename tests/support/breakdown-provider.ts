/**
 * Wraps a provider so `generateObject('section_briefs')` answers like a well-behaved model: one
 * brief per listed part, each citing the part's own section. Records every prompt so tests can
 * check what was sent, and counts calls so they can prove when generation did not happen.
 */
import type {
  LlmProvider,
  ObjectRequest,
  LlmTextPart,
} from '../../src/core/model/index.js';
import { messageText } from '../../src/core/model/index.js';

export interface BreakdownProvider extends LlmProvider {
  breakdownCalls: number;
  /** Every breakdown request, as sent. */
  requests: ObjectRequest<unknown>[];
  /** Ids whose example should be `none`; everything else is `available`. */
  noExample: Set<string>;
  /** Replace the reply (return the object) or throw. */
  behavior?: (req: ObjectRequest<unknown>) => unknown;
  /** Awaited at the start of each breakdown call. */
  gate?: () => Promise<void>;
}

/** The part ids a batch question lists, in order. */
export function listedIds(prompt: string | readonly LlmTextPart[]): string[] {
  return [...messageText(prompt).matchAll(/^- id (\S+):/gm)].map(
    (m) => m[1] ?? '',
  );
}

export function breakdownProvider(base: LlmProvider): BreakdownProvider {
  const provider: BreakdownProvider = {
    id: base.id,
    model: base.model,
    breakdownCalls: 0,
    requests: [],
    noExample: new Set(),
    streamText: (req) => base.streamText(req),
    generateObject: async <T>(req: ObjectRequest<T>) => {
      if (req.schemaName !== 'section_briefs') return base.generateObject(req);
      provider.breakdownCalls++;
      provider.requests.push(req);
      await provider.gate?.();
      const object = provider.behavior
        ? provider.behavior(req)
        : {
            briefs: listedIds(req.prompt).map((id) => ({
              id,
              text: `This part sets rules for ${id}. [S:${id}]`,
              example: provider.noExample.has(id) ? 'none' : 'available',
            })),
          };
      return {
        object: object as T,
        usage: { inputTokens: 11, outputTokens: 13 },
      };
    },
  };
  return provider;
}
