import { expect, it } from 'vitest';
import { asset, drain, httpReplay, KEY } from '../../../tests/llm/http.js';
import { describeHttpProvider } from '../../../tests/llm/provider-tests.js';
import { AnthropicProvider } from './anthropic.js';

describeHttpProvider(
  'anthropic',
  (fetch, config) =>
    new AnthropicProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: KEY,
        ...config,
      },
      { fetch },
    ),
);
it('ignores thinking deltas and refuses missing message_stop', async () => {
  const body = asset('anthropic-stream.sse').replace(
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    '',
  );
  await expect(
    drain(
      new AnthropicProvider(
        { provider: 'anthropic', model: 'test', apiKey: KEY },
        { fetch: httpReplay([{ body, stream: true }]).fetch },
      ),
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
});
