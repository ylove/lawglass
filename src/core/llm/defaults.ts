import type { ProviderId } from '../model/index.js';

export type ModelPurpose = 'answer' | 'extract';
export const DEFAULT_MODELS: Readonly<
  Record<ProviderId, Readonly<Record<ModelPurpose, string>>>
> = {
  anthropic: { answer: 'claude-sonnet-5-5', extract: 'claude-haiku-5-5' },
  // Re-verified 2026-10-13: https://developers.openai.com/api/docs/models
  // Catalog IDs: Sol balances intelligence/cost; Luna serves cost-sensitive workloads.
  openai: { answer: 'gpt-6.1-sol', extract: 'gpt-6-luna' },
  // Re-verified 2026-10-13: https://ai.google.dev/gemini-api/docs/models
  // Catalog recommends 3.8 Flash / 3.5 Flash-Lite for new projects; both are stable IDs.
  google: { answer: 'gemini-3.8-flash', extract: 'gemini-3.5-flash-lite' },
  'claude-cli': { answer: 'claude-sonnet-5-5', extract: 'claude-haiku-5-5' },
  mock: { answer: 'deterministic', extract: 'deterministic' },
};

export function defaultModel(
  provider: ProviderId,
  purpose: ModelPurpose,
): string {
  return DEFAULT_MODELS[provider][purpose];
}
