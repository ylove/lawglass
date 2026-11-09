import { z } from 'zod';
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

it('marks the cache breakpoint after the bill part and sends effort', async () => {
  const replay = httpReplay([
    { body: asset('anthropic-stream.sse'), stream: true },
  ]);
  const provider = new AnthropicProvider(
    { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY },
    { fetch: replay.fetch },
  );
  for await (const event of provider.streamText({
    system: 'rules',
    messages: [
      {
        role: 'user',
        content: [
          { text: '<bill>…</bill>\n', cache: true },
          { text: '<question>When?</question>' },
        ],
      },
    ],
    maxTokens: 100,
    effort: 'medium',
  })) {
    expect(event.type).toMatch(/text|done/);
  }
  const sent = (await replay.requests[0]!.json()) as {
    messages: { content: { text: string; cache_control?: unknown }[] }[];
    output_config?: { effort?: string };
  };
  const blocks = sent.messages[0]!.content;
  expect(blocks.map((b) => b.cache_control)).toEqual([
    { type: 'ephemeral' },
    undefined,
  ]);
  expect(blocks.map((b) => b.text).join('')).toBe(
    '<bill>…</bill>\n<question>When?</question>',
  );
  expect(sent.output_config).toEqual({ effort: 'medium' });
});

it('sends a plain string message unchanged and no effort by default', async () => {
  const replay = httpReplay([
    { body: asset('anthropic-stream.sse'), stream: true },
  ]);
  const provider = new AnthropicProvider(
    { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY },
    { fetch: replay.fetch },
  );
  for await (const event of provider.streamText({
    system: 'rules',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 100,
  })) {
    expect(event.type).toMatch(/text|done/);
  }
  const sent = (await replay.requests[0]!.json()) as {
    messages: { content: unknown }[];
    output_config?: unknown;
  };
  expect(sent.messages[0]!.content).toBe('hello');
  expect(sent.output_config).toBeUndefined();
});

it('carries a cached prompt part and effort into structured output', async () => {
  const replay = httpReplay([{ body: asset('anthropic-object.json') }]);
  const provider = new AnthropicProvider(
    { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY },
    { fetch: replay.fetch },
  );
  await provider.generateObject({
    system: 'Extract fields',
    prompt: [
      { text: '<bill>…</bill>\n', cache: true },
      { text: '<task>Brief each part.</task>' },
    ],
    schema: z.object({
      billNumber: z.string().nullable(),
      sponsors: z.array(z.string()).nullable(),
    }),
    schemaName: 'bill_fields',
    maxTokens: 200,
    effort: 'low',
  });
  const sent = (await replay.requests[0]!.json()) as {
    messages: { content: { text: string; cache_control?: unknown }[] }[];
    output_config: { effort?: string; format?: unknown };
  };
  expect(sent.messages[0]!.content.map((b) => b.cache_control)).toEqual([
    { type: 'ephemeral' },
    undefined,
  ]);
  expect(sent.output_config.effort).toBe('low');
  expect(sent.output_config.format).toBeDefined();
});

it('reports the billed input and the output so far when a reader leaves mid-stream', async () => {
  const provider = new AnthropicProvider(
    { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY },
    {
      fetch: httpReplay([{ body: asset('anthropic-stream.sse'), stream: true }])
        .fetch,
    },
  );
  const partial: unknown[] = [];
  for await (const event of provider.streamText({
    system: 'rules',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 100,
    onPartialUsage: (usage) => partial.push(usage),
  })) {
    if (event.type === 'text') break;
  }
  expect(partial).toHaveLength(1);
  expect(partial[0]).toMatchObject({ inputTokens: 10 });
});

it('does not report partial usage for a stream that finished', async () => {
  const provider = new AnthropicProvider(
    { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY },
    {
      fetch: httpReplay([{ body: asset('anthropic-stream.sse'), stream: true }])
        .fetch,
    },
  );
  const partial: unknown[] = [];
  const events: string[] = [];
  for await (const event of provider.streamText({
    system: 'rules',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 100,
    onPartialUsage: (usage) => partial.push(usage),
  }))
    events.push(event.type);
  expect(events.at(-1)).toBe('done');
  expect(partial).toEqual([]);
});
