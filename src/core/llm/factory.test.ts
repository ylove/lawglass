import { describe, expect, it, vi } from 'vitest';
import { createProvider, defaultModel, MockProvider } from './index.js';
import type { ProviderId } from '../model/index.js';
describe('provider factory', () => {
  it('creates each explicitly selected adapter with model overrides', () => {
    vi.stubEnv('CI', '');
    try {
      for (const provider of [
        'mock',
        'anthropic',
        'openai',
        'google',
        'claude-cli',
      ] as const) {
        const result = createProvider({
          provider,
          model: 'override',
          apiKey: 'test-key',
        });
        expect(result.id).toBe(provider);
        expect(result.model).toBe('override');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('uses answer defaults for an empty configured model', () => {
    for (const provider of ['mock', 'anthropic', 'openai', 'google'] as const)
      expect(
        createProvider({ provider, model: ' ', apiKey: 'test-key' }).model,
      ).toBe(defaultModel(provider, 'answer'));
    expect(createProvider({ provider: 'mock', model: '' })).toBeInstanceOf(
      MockProvider,
    );
  });
  it('rejects unrecognized providers and never silently chooses a paid provider', () => {
    expect(() =>
      createProvider({ provider: 'unknown' as ProviderId, model: 'test' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    for (const provider of ['anthropic', 'openai', 'google'] as const)
      expect(() => createProvider({ provider, model: 'test' })).toThrow(
        expect.objectContaining({ code: 'MISSING_KEY' }),
      );
  });
  it('uses the OpenAI baseURL environment override for keyless local endpoints', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://localhost:11434/v1');
    try {
      expect(
        createProvider({ provider: 'openai', model: 'local-model' }).id,
      ).toBe('openai');
      expect(() =>
        createProvider({
          provider: 'openai',
          model: 'test',
          baseURL: 'https://openrouter.ai/api/v1',
        }),
      ).toThrow(expect.objectContaining({ code: 'MISSING_KEY' }));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
