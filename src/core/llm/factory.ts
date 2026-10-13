import {
  AppError,
  type LlmProvider,
  type ProviderConfig,
} from '../model/index.js';
import { AnthropicProvider } from './anthropic.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { defaultModel } from './defaults.js';
import { GoogleProvider } from './google.js';
import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';

/** Keys are resolved by the caller. Only an explicit provider selection enables claude-cli. */
export function createProvider(config: ProviderConfig): LlmProvider {
  if (
    !['anthropic', 'openai', 'google', 'claude-cli', 'mock'].includes(
      config.provider,
    )
  )
    throw new AppError('INVALID_INPUT');
  const resolved = {
    ...config,
    model: config.model.trim() || defaultModel(config.provider, 'answer'),
  };
  switch (resolved.provider) {
    case 'anthropic':
      return new AnthropicProvider(resolved);
    case 'openai':
      return new OpenAIProvider({
        ...resolved,
        baseURL: config.baseURL ?? process.env.OPENAI_BASE_URL,
      });
    case 'google':
      return new GoogleProvider(resolved);
    case 'claude-cli':
      return new ClaudeCliProvider(resolved);
    case 'mock':
      return new MockProvider(resolved.model);
  }
}
