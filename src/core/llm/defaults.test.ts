import { expect, it } from 'vitest';
import { DEFAULT_MODELS, defaultModel } from './defaults.js';
it('defines answer and extraction models for all providers', () => {
  for (const provider of [
    'mock',
    'anthropic',
    'openai',
    'google',
    'claude-cli',
  ] as const) {
    expect(defaultModel(provider, 'answer')).toBe(
      DEFAULT_MODELS[provider].answer,
    );
    expect(defaultModel(provider, 'extract').length).toBeGreaterThan(0);
  }
  expect(DEFAULT_MODELS.anthropic).toEqual({
    answer: 'claude-sonnet-5-5',
    extract: 'claude-haiku-5-5',
  });
  expect(DEFAULT_MODELS.openai).toEqual({
    answer: 'gpt-6.1-sol',
    extract: 'gpt-6-luna',
  });
  expect(DEFAULT_MODELS.google).toEqual({
    answer: 'gemini-3.8-flash',
    extract: 'gemini-3.5-flash-lite',
  });
});
