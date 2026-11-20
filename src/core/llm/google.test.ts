import { expect, it } from 'vitest';
import {
  asset,
  drain,
  httpReplay,
  KEY,
  textRequest,
} from '../../../tests/llm/http.js';
import {
  describeHttpProvider,
  objectRequest,
} from '../../../tests/llm/provider-tests.js';
import { GoogleProvider } from './google.js';
const make = (fetch: typeof globalThis.fetch) =>
  new GoogleProvider(
    { provider: 'google', model: 'gemini-3.8-flash', apiKey: KEY },
    { fetch },
  );
describeHttpProvider(
  'google',
  (fetch, config) =>
    new GoogleProvider(
      { provider: 'google', model: 'gemini-3.8-flash', apiKey: KEY, ...config },
      { fetch },
    ),
);
it('maps assistant messages to model role and omits internal thoughts', async () => {
  const replay = httpReplay([
    {
      stream: true,
      body: 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Hidden"},{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"thoughtsTokenCount":3}}\n\n',
    },
  ]);
  const events = await drain(make(replay.fetch), {
    ...textRequest,
    messages: [
      { role: 'assistant', content: 'Prior reply' },
      { role: 'user', content: 'Hello' },
    ],
  });
  expect(events).toEqual([
    { type: 'text', text: 'Hello' },
    {
      type: 'done',
      stopReason: 'STOP',
      usage: { inputTokens: 1, outputTokens: 5 },
    },
  ]);
  expect(await replay.requests[0]!.json()).toMatchObject({
    contents: [
      { role: 'model', parts: [{ text: 'Prior reply' }] },
      { role: 'user', parts: [{ text: 'Hello' }] },
    ],
  });
});
it('defaults missing usage to zero', async () => {
  const body = JSON.parse(asset('google-object.json')) as Record<
    string,
    unknown
  >;
  delete body.usageMetadata;
  expect(
    (
      await make(
        httpReplay([{ body: JSON.stringify(body) }]).fetch,
      ).generateObject(objectRequest)
    ).usage,
  ).toEqual({ inputTokens: 0, outputTokens: 0 });
});
it('asks the SDK for one HTTP request per call: automatic continuation is off', async () => {
  const replay = httpReplay([
    {
      body: asset('google-object.json'),
    },
  ]);
  const provider = make(replay.fetch);
  const models = (
    provider as unknown as {
      client: {
        models: Record<string, (...args: unknown[]) => Promise<unknown>>;
      };
    }
  ).client.models;
  const configs: unknown[] = [];
  for (const method of ['generateContent', 'generateContentStream'] as const) {
    const original = models[method]!.bind(models);
    models[method] = (...args: unknown[]) => {
      configs.push((args[0] as { config?: unknown }).config);
      return original(...args);
    };
  }
  await provider.generateObject(objectRequest);
  expect(replay.requests).toHaveLength(1);
  expect(configs[0]).toMatchObject({
    automaticFunctionCalling: { disable: true },
  });
});
