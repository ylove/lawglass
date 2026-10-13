import { describe, expect, it } from 'vitest';
import { asset, drain, httpReplay, KEY } from '../../../tests/llm/http.js';
import {
  describeHttpProvider,
  objectRequest,
} from '../../../tests/llm/provider-tests.js';
import { OpenAIProvider } from './openai.js';
const make = (fetch: typeof globalThis.fetch, overrides = {}) =>
  new OpenAIProvider(
    { provider: 'openai', model: 'gpt-6.1-sol', apiKey: KEY, ...overrides },
    { fetch },
  );
describeHttpProvider('openai', (fetch, config) => make(fetch, config));
const rejection = (format: string) => ({
  status: 400,
  body: JSON.stringify({
    error: {
      message: `Unsupported ${format}`,
      param: 'response_format',
      type: 'invalid_request_error',
    },
  }),
});
describe('OpenAI compatibility', () => {
  it('retries a 400 stream_options rejection once without the option and reports zero usage', async () => {
    const replay = httpReplay([
      {
        status: 400,
        body: JSON.stringify({
          error: {
            message: 'Unknown parameter: stream_options',
            type: 'invalid_request_error',
          },
        }),
      },
      { body: asset('openai-stream.sse'), stream: true },
    ]);
    const events = await drain(
      make(replay.fetch, {
        baseURL: 'https://compatible.example/v1',
      }),
    );
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    ).toBe('Hello world.');
    expect(events.filter((e) => e.type === 'done')).toEqual([
      {
        type: 'done',
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'stop',
      },
    ]);
    expect(replay.requests).toHaveLength(2);
    const first = (await replay.requests[0]!.json()) as Record<string, unknown>;
    const second = (await replay.requests[1]!.json()) as Record<
      string,
      unknown
    >;
    expect(first.stream_options).toEqual({ include_usage: true });
    expect(second).not.toHaveProperty('stream_options');
    const { stream_options: _streamOptions, ...withoutOptions } = first;
    expect(second).toEqual(withoutOptions);
    expect(replay.requests[1]!.headers.get('authorization')).toBe(
      `Bearer ${KEY}`,
    );
  });
  it.each([
    { status: 400, message: 'Invalid model' },
    { status: 401, message: 'stream_options authentication failure' },
    { status: 422, message: 'Unsupported stream_options' },
  ])(
    'does not retry unrelated streaming failures ($status: $message)',
    async ({ status, message }) => {
      const replay = httpReplay([
        {
          status,
          body: JSON.stringify({ error: { message } }),
        },
      ]);
      await expect(drain(make(replay.fetch))).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
      expect(replay.requests).toHaveLength(1);
    },
  );
  it('does not retry again when the stream_options fallback fails', async () => {
    const reply = {
      status: 400,
      body: '{"error":{"message":"Unsupported stream_options"}}',
    };
    const replay = httpReplay([reply, reply]);
    await expect(drain(make(replay.fetch))).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(replay.requests).toHaveLength(2);
  });
  it('falls back from JSON schema to JSON object then plain JSON, with validation', async () => {
    const replay = httpReplay([
      rejection('json_schema'),
      rejection('json_object'),
      {
        body: asset('openai-object.json').replace(
          '{\\"billNumber\\":null,\\"sponsors\\":null}',
          '```json\\n{\\"billNumber\\":null,\\"sponsors\\":null}\\n```',
        ),
      },
    ]);
    expect(
      (await make(replay.fetch).generateObject(objectRequest)).object,
    ).toEqual({ billNumber: null, sponsors: null });
    const bodies = await Promise.all(
      replay.requests.map((r) => r.json() as Promise<Record<string, unknown>>),
    );
    expect(bodies.map((b) => b.response_format)).toEqual([
      expect.objectContaining({ type: 'json_schema' }),
      { type: 'json_object' },
      undefined,
    ]);
  });
  it('accepts JSON-object support without reaching plain fallback', async () => {
    const replay = httpReplay([
      rejection('json_schema'),
      { body: asset('openai-object.json') },
    ]);
    await make(replay.fetch).generateObject(objectRequest);
    expect(replay.requests).toHaveLength(2);
  });
  it('does not downgrade for unrelated invalid requests, schema mismatch or refusal', async () => {
    for (const reply of [
      {
        status: 400,
        body: '{"error":{"message":"Invalid model","param":"model"}}',
      },
      {
        body: asset('openai-object.json').replace(
          '"refusal": null',
          '"refusal": "No"',
        ),
      },
      {
        body: asset('openai-object.json').replace(
          '"finish_reason": "stop"',
          '"finish_reason": "length"',
        ),
      },
    ]) {
      const replay = httpReplay([reply]);
      await expect(
        make(replay.fetch).generateObject(objectRequest),
      ).rejects.toHaveProperty('code');
      expect(replay.requests).toHaveLength(1);
    }
    const replay = httpReplay([
      rejection('json_schema'),
      rejection('json_object'),
      rejection('plain'),
    ]);
    await expect(
      make(replay.fetch).generateObject(objectRequest),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:1234/v1',
  ])('supports keyless local server %s', async (baseURL) => {
    const replay = httpReplay([
      { body: asset('openai-stream.sse'), stream: true },
    ]);
    await drain(make(replay.fetch, { baseURL, apiKey: undefined }));
    expect(replay.requests[0]!.url).toBe(`${baseURL}/chat/completions`);
    expect(replay.requests[0]!.headers.get('authorization')).toBe(
      'Bearer local',
    );
    const body: unknown = await replay.requests[0]!.json();
    expect(body).toMatchObject({ max_tokens: 50 });
  });
  it('requires a key for remote compatible endpoints, and forwards only the configured key', async () => {
    for (const baseURL of [
      'https://openrouter.ai/api/v1',
      'broken',
      'ftp://localhost/v1',
    ]) {
      expect(() =>
        make(httpReplay([]).fetch, { baseURL, apiKey: undefined }),
      ).toThrow(expect.objectContaining({ code: 'MISSING_KEY' }));
    }
    const replay = httpReplay([{ body: asset('openai-object.json') }]);
    await make(replay.fetch, {
      baseURL: 'https://openrouter.ai/api/v1',
    }).generateObject(objectRequest);
    expect(replay.requests[0]!.url).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(replay.requests[0]!.headers.get('authorization')).toBe(
      `Bearer ${KEY}`,
    );
  });
  it('uses current token limits for official models and tolerates missing usage', async () => {
    const replay = httpReplay([{ body: asset('openai-object.json') }]);
    await make(replay.fetch).generateObject(objectRequest);
    expect(await replay.requests[0]!.json()).toMatchObject({
      max_completion_tokens: 200,
    });
    const body = JSON.parse(asset('openai-object.json')) as Record<
      string,
      unknown
    >;
    delete body.usage;
    const result = await make(
      httpReplay([{ body: JSON.stringify(body) }]).fetch,
      { model: 'gpt-4.1' },
    ).generateObject(objectRequest);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
