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
import { newSpend, runInJob } from '../cost/index.js';
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
const continuation = (text: string) => ({
  candidates: [
    {
      content: { parts: [{ text }] },
      finishReason: 'CONTINUATION',
      continuationToken: 'token-1',
    },
  ],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
});
/** Runs `fn` inside a job whose host has (or has not) a per-call gate. */
const inJob = <T>(gated: boolean, fn: () => Promise<T>): Promise<T> =>
  runInJob(
    {
      context: { readerId: 'a', jobKind: 'question', jobId: 'j' },
      spent: newSpend(),
      ...(gated ? { callGate: () => true } : {}),
    },
    fn,
  );
it('under a call gate, one HTTP request per call even when the model answers CONTINUATION (object)', async () => {
  const replay = httpReplay([
    {
      body: JSON.stringify(continuation('{"billNumber":null,"sponsors":null}')),
    },
    { body: asset('google-object.json') },
  ]);
  await inJob(true, () =>
    make(replay.fetch).generateObject(objectRequest),
  ).catch(() => undefined);
  // The SDK would have resumed from the token with a second billed request.
  expect(replay.requests).toHaveLength(1);
});
it('under a call gate, one HTTP request per call even when the stream ends at a CONTINUATION checkpoint', async () => {
  const replay = httpReplay([
    {
      stream: true,
      body: `data: ${JSON.stringify(continuation('Hello'))}\n\n`,
    },
    { stream: true, body: asset('google-stream.sse') },
  ]);
  await inJob(true, () => drain(make(replay.fetch))).catch(() => undefined);
  expect(replay.requests).toHaveLength(1);
});
it('without a call gate the SDK default is unchanged: a split reply still assembles across hops', async () => {
  const replay = httpReplay([
    { body: JSON.stringify(continuation('{"billNumber":null,')) },
    { body: asset('google-object.json') },
  ]);
  await inJob(false, () =>
    make(replay.fetch).generateObject(objectRequest),
  ).catch(() => undefined);
  expect(replay.requests.length).toBeGreaterThan(1);
  // And with no job at all, as in a local run.
  const local = httpReplay([
    { body: JSON.stringify(continuation('{"billNumber":null,')) },
    { body: asset('google-object.json') },
  ]);
  await make(local.fetch)
    .generateObject(objectRequest)
    .catch(() => undefined);
  expect(local.requests.length).toBeGreaterThan(1);
});
