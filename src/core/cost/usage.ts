import type { LlmUsage } from '../model/index.js';

export type UsageFeature =
  | 'metadata'
  | 'summary'
  | 'breakdown'
  | 'pictures'
  | 'examples'
  | 'scenario'
  | 'question'
  | 'chip'
  | 'locate'
  | 'unknown';
export interface UsageEvent {
  feature: UsageFeature;
  model: string;
  usage: LlmUsage;
}
/** Called once when a call reports usage. Failed calls without usage cannot be accounted for.
 * No prompts, credentials or job context cross this seam (#383 will add attribution).
 */
export interface UsageSink {
  record(event: UsageEvent): void | Promise<void>;
}
export const NOOP_USAGE_SINK: UsageSink = {
  record() {
    // Accounting is opt-in; the default retains no events.
  },
};

/** Preserve optional cache splits when a feature aggregates retries or batches. */
export function addLlmUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadTokens === undefined && b.cacheReadTokens === undefined
      ? {}
      : {
          cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
        }),
    ...(a.cacheWriteTokens === undefined && b.cacheWriteTokens === undefined
      ? {}
      : {
          cacheWriteTokens:
            (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
        }),
  };
}
