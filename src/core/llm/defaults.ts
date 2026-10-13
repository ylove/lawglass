import type { ProviderId } from '../model/index.js';

export type ModelPurpose = 'answer' | 'extract';
export const DEFAULT_MODELS: Readonly<
  Record<ProviderId, Readonly<Record<ModelPurpose, string>>>
> = {
  anthropic: { answer: 'claude-sonnet-5-5', extract: 'claude-haiku-5-5' },
  // Verified 2026-10-13: https://developers.openai.com/api/docs/models
  // Sol balances general-purpose quality/cost; Luna is the cost-sensitive extraction model.
  openai: { answer: 'gpt-6.1-sol', extract: 'gpt-6-luna' },
  // Verified 2026-10-13: https://ai.google.dev/gemini-api/docs/models
  // Google's recommended current text models for new projects, without preview aliases.
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
