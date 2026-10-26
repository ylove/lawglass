import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { inspect } from 'node:util';
import type {
  LlmProvider,
  ProviderConfig,
} from '../../src/core/model/index.js';
import { describeProviderContract } from '../contracts/provider.contract.js';
import { asset, drain, httpReplay, KEY, textRequest } from './http.js';

export const objectSchema = z.object({
  billNumber: z.string().nullable(),
  sponsors: z.array(z.string()).nullable(),
});
export const objectRequest = {
  system: 'Extract fields',
  prompt: 'private request body',
  schema: objectSchema,
  schemaName: 'bill_fields',
  maxTokens: 200,
};
export type MakeHttpProvider = (
  fetcher: typeof fetch,
  config?: Partial<ProviderConfig>,
) => LlmProvider;

export function describeHttpProvider(
  name: 'anthropic' | 'openai' | 'google',
  make: MakeHttpProvider,
) {
  describeProviderContract(`${name} HTTP replay`, () =>
    make(async (input, init) => {
      const request = new Request(input, init);
      const body: unknown = await request.clone().json();
      const streaming =
        request.url.includes('streamGenerateContent') ||
        (typeof body === 'object' &&
          body !== null &&
          'stream' in body &&
          body.stream === true);
      return new Response(
        asset(`${name}-${streaming ? 'stream.sse' : 'object.json'}`),
        {
          headers: {
            'content-type': streaming
              ? 'text/event-stream'
              : 'application/json',
          },
        },
      );
    }),
  );
  describe(`${name} recorded HTTP`, () => {
    it('sends every structured-prompt part, in order, as text', async () => {
      const replay = httpReplay([{ body: asset(`${name}-object.json`) }]);
      await make(replay.fetch).generateObject({
        ...objectRequest,
        prompt: [
          { text: 'PART-ONE the bill. ', cache: true },
          { text: 'PART-TWO the task.' },
        ],
      });
      const sent = await replay.requests[0]!.text();
      expect(sent.indexOf('PART-ONE')).toBeGreaterThanOrEqual(0);
      expect(sent.indexOf('PART-ONE')).toBeLessThan(sent.indexOf('PART-TWO'));
      expect(sent).not.toContain('[object Object]');
    });

    it('sends every message part, in order, and reports cached input when the provider does', async () => {
      const cachedUsage = {
        anthropic: (sse: string) =>
          sse.replace(
            '"input_tokens":10',
            '"input_tokens":2,"cache_read_input_tokens":8',
          ),
        openai: (sse: string) =>
          sse.replace(
            '"prompt_tokens":10,',
            '"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":8},',
          ),
        google: (sse: string) =>
          sse.replace(
            '"promptTokenCount":10,',
            '"promptTokenCount":10,"cachedContentTokenCount":8,',
          ),
      }[name];
      const body = cachedUsage(asset(`${name}-stream.sse`));
      expect(body).toContain('8'); // the replay edit applied
      const replay = httpReplay([{ body, stream: true }]);
      const events = await drain(make(replay.fetch), {
        ...textRequest,
        messages: [
          {
            role: 'user',
            content: [
              { text: 'PART-ONE the bill. ', cache: true },
              { text: 'PART-TWO the question.' },
            ],
          },
        ],
      });
      const sent = await replay.requests[0]!.text();
      expect(sent.indexOf('PART-ONE')).toBeGreaterThanOrEqual(0);
      expect(sent.indexOf('PART-ONE')).toBeLessThan(sent.indexOf('PART-TWO'));
      expect(sent).not.toContain('[object Object]');
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        usage: { inputTokens: 10, cacheReadTokens: 8 },
      });
    });

    it('parses fragmented SSE and reports usage with a single terminal event', async () => {
      const replay = httpReplay([
        { body: asset(`${name}-stream.sse`), stream: true },
      ]);
      const events = await drain(make(replay.fetch));
      expect(
        events
          .filter((e) => e.type === 'text')
          .map((e) => e.text)
          .join(''),
      ).toBe('Hello world.');
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        usage: { inputTokens: 10, outputTokens: 3 },
      });
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      const request = replay.requests[0]!;
      expect(new URL(request.url).hostname).toBe(
        {
          anthropic: 'api.anthropic.com',
          openai: 'api.openai.com',
          google: 'generativelanguage.googleapis.com',
        }[name],
      );
      expect(
        request.headers.get(
          name === 'anthropic'
            ? 'x-api-key'
            : name === 'google'
              ? 'x-goog-api-key'
              : 'authorization',
        ),
      ).toContain(KEY);
    });
    it('sends a native JSON schema and validates the result', async () => {
      const replay = httpReplay([{ body: asset(`${name}-object.json`) }]);
      expect(await make(replay.fetch).generateObject(objectRequest)).toEqual({
        object: { billNumber: null, sponsors: null },
        usage: { inputTokens: 10, outputTokens: 8 },
      });
      const body: unknown = await replay.requests[0]!.json();
      expect(JSON.stringify(body)).toContain('billNumber');
      expect(JSON.stringify(body)).toContain(
        'json_schema'.replace(
          'json_schema',
          name === 'google' ? 'responseJsonSchema' : 'json_schema',
        ),
      );
    });
    it.each([401, 429, 503])(
      'maps HTTP %s without logging or retaining secrets',
      async (status) => {
        const spies = [
          vi.spyOn(console, 'log'),
          vi.spyOn(console, 'warn'),
          vi.spyOn(console, 'error'),
          vi.spyOn(console, 'debug'),
          vi.spyOn(console, 'info'),
        ];
        try {
          for (const operation of ['text', 'object'] as const) {
            const replay = httpReplay([
              {
                status,
                body: JSON.stringify({
                  error: {
                    message: `${KEY}: private request body`,
                    type: 'authentication_error',
                    code: status,
                  },
                }),
              },
            ]);
            const provider = make(replay.fetch);
            const error: unknown = await (
              operation === 'text'
                ? drain(provider)
                : provider.generateObject(objectRequest)
            ).catch((e: unknown) => e);
            expect(error).toMatchObject({ code: 'PROVIDER_ERROR' });
            expect(inspect(error)).not.toContain(KEY);
            expect(inspect(error)).not.toContain(objectRequest.prompt);
            expect(replay.requests).toHaveLength(1);
          }
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally {
          spies.forEach((spy) => {
            spy.mockRestore();
          });
        }
      },
    );
    it('sanitizes network failures and missing-key errors', async () => {
      const provider = make(() => Promise.reject(new Error(KEY)));
      await expect(drain(provider)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
        cause: undefined,
      });
      await expect(
        provider.generateObject(objectRequest),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', cause: undefined });
      expect(() => make(httpReplay([]).fetch, { apiKey: undefined })).toThrow(
        expect.objectContaining({ code: 'MISSING_KEY' }),
      );
    });
    it('rejects invalid JSON, schema mismatches, and missing content', async () => {
      for (const replacement of [
        'not JSON',
        '{"billNumber":123,"sponsors":[]}',
        '',
      ]) {
        const body = asset(`${name}-object.json`).replace(
          '{\\"billNumber\\":null,\\"sponsors\\":null}',
          replacement.replaceAll('"', '\\"'),
        );
        await expect(
          make(httpReplay([{ body }]).fetch).generateObject(objectRequest),
        ).rejects.toMatchObject({ code: 'PROVIDER_BAD_OUTPUT' });
      }
    });
    it('rejects pre-aborted structured output without sending a request', async () => {
      const replay = httpReplay([]);
      await expect(
        make(replay.fetch).generateObject({
          ...objectRequest,
          signal: AbortSignal.abort(),
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(replay.requests).toHaveLength(0);
    });
    it('aborts in-flight requests and applies the total request timeout', async () => {
      const fetcher: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new Error(KEY));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error(KEY));
            },
            { once: true },
          );
        });
      await expect(
        drain(make(fetcher, { timeoutMs: 20 })),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      const ac = new AbortController();
      const promise = make(fetcher).generateObject({
        ...objectRequest,
        signal: ac.signal,
      });
      ac.abort();
      await expect(promise).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });
    it('closes streaming resources when the caller stops consuming', async () => {
      const replay = httpReplay([
        { body: asset(`${name}-stream.sse`), stream: true },
      ]);
      const iterator = make(replay.fetch)
        .streamText(textRequest)
        [Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: 'text' });
      await iterator.return?.();
    });
    if (name !== 'anthropic')
      it('rejects an incomplete stream instead of reporting success', async () => {
        const body =
          name === 'openai'
            ? 'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n'
            : 'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n';
        await expect(
          drain(make(httpReplay([{ body, stream: true }]).fetch)),
        ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      });
  });
}
