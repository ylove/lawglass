import { describeProviderContract } from '../contracts/provider.contract.js';
import { createProvider, defaultModel } from '../../src/core/llm/index.js';

for (const [provider, variable] of [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['google', 'GEMINI_API_KEY'],
] as const) {
  const apiKey =
    process.env[variable] ??
    (provider === 'google' ? process.env.GOOGLE_API_KEY : undefined);
  describeProviderContract(
    provider,
    () =>
      createProvider({
        provider,
        apiKey,
        model: defaultModel(provider, 'answer'),
      }),
    {
      skip: !apiKey?.trim(),
      timeoutMs: 120_000,
    },
  );
}
