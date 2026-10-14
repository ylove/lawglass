import { describe, expect, test, vi } from 'vitest';
import { createHttpApi, selectApi, ApiError } from './api.js';
import { parseSseBlocks, readSseEvents } from './sse.js';
import { z } from 'zod';

const enc = new TextEncoder();

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

const Tok = z.object({ type: z.literal('token'), text: z.string() });

describe('SSE parsing', () => {
  test('joins data lines, skips comments and handles CRLF', () => {
    const items = [
      ...parseSseBlocks(
        ': hi\r\n\r\nevent: x\r\ndata: {"a":1}\r\n\r\ndata: par',
        false,
      ),
    ];
    expect(items).toEqual([{ data: '{"a":1}' }, { rest: 'data: par' }]);
  });

  test('events split across arbitrary chunk boundaries are reassembled', async () => {
    const line = 'data: {"type":"token","text":"héllo"}\n\n';
    const bytes = enc.encode(line + line);
    // Split in the middle of a multi-byte character.
    const cut = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const events = await collect(readSseEvents(new Response(stream), Tok));
    expect(events.map((e) => e.text)).toEqual(['héllo', 'héllo']);
  });

  test('a CRLF split between CR and LF across chunks is one line break', async () => {
    const events = await collect(
      readSseEvents(
        sseResponse([
          'data: {"type":"token",\r',
          '\ndata: "text":"x"}\r\n\r\n',
        ]),
        Tok,
      ),
    );
    expect(events).toEqual([{ type: 'token', text: 'x' }]);
    const split = await collect(
      readSseEvents(
        sseResponse(['data: {"type":"token","text":"y"}\r\n\r', '\n']),
        Tok,
      ),
    );
    expect(split).toEqual([{ type: 'token', text: 'y' }]);
  });

  test('a stream that ends mid-event reports the answer was cut off', async () => {
    await expect(
      collect(readSseEvents(sseResponse(['data: {"type":"token","te']), Tok)),
    ).rejects.toThrow('cut off');
    await expect(
      collect(readSseEvents(sseResponse(['data: nope\n\n']), Tok)),
    ).rejects.toThrow('unreadable');
  });

  test('a final event without a trailing blank line is still delivered', async () => {
    const events = await collect(
      readSseEvents(sseResponse(['data: {"type":"token","text":"x"}']), Tok),
    );
    expect(events).toHaveLength(1);
  });

  test('rejects malformed JSON and schema violations with plain messages', async () => {
    await expect(
      collect(readSseEvents(sseResponse(['data: nope\n\n']), Tok)),
    ).rejects.toThrow('unreadable');
    await expect(
      collect(readSseEvents(sseResponse(['data: {"type":"other"}\n\n']), Tok)),
    ).rejects.toThrow('unexpected');
  });

  test('rejects a response with no body', async () => {
    await expect(
      collect(readSseEvents(new Response(null), Tok)),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('HTTP client', () => {
  const config = {
    productName: 'X',
    publicMode: false,
    freeformEnabled: true,
    backend: 'local',
    provider: 'mock',
    model: 'm',
    chips: [{ id: 'summary', label: 'Summary' }],
    scenariosEnabled: true,
  };

  test('getConfig validates the body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json(config)),
    ) as unknown as typeof fetch;
    const api = createHttpApi({ fetchImpl });
    await expect(api.getConfig()).resolves.toMatchObject({ productName: 'X' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/config', undefined);
  });

  test('a body that breaks the contract is rejected', async () => {
    const fetchImpl = (() =>
      Promise.resolve(Response.json({ nope: 1 }))) as typeof fetch;
    await expect(createHttpApi({ fetchImpl }).getConfig()).rejects.toThrow(
      'unexpected',
    );
  });

  test('server error bodies surface their message; others get a generic one', async () => {
    const api = (res: Response) =>
      createHttpApi({
        fetchImpl: () => Promise.resolve(res),
      });
    await expect(
      api(
        Response.json(
          { error: { code: 'DOC_NOT_FOUND', message: 'Gone.' } },
          { status: 404 },
        ),
      ).getDoc('a'),
    ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND', message: 'Gone.' });
    await expect(
      api(
        Response.json({ code: 'X', message: 'Flat.' }, { status: 400 }),
      ).listDocs(),
    ).rejects.toMatchObject({ message: 'Flat.' });
    await expect(
      api(new Response('boom', { status: 502 })).listDocs(),
    ).rejects.toThrow('status 502');
  });

  test('network failures become a plain message; aborts pass through', async () => {
    const down = createHttpApi({
      fetchImpl: () => Promise.reject(new TypeError('fail')),
    });
    await expect(down.listDocs()).rejects.toThrow('Could not reach the server');
    const aborted = createHttpApi({
      fetchImpl: () => Promise.reject(new DOMException('x', 'AbortError')),
    });
    await expect(aborted.listDocs()).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test('removeDoc and encoded paths', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    const api = createHttpApi({ fetchImpl, baseUrl: 'http://h' });
    await api.removeDoc('a/b');
    expect(calls[0]).toEqual(['http://h/api/docs/a%2Fb', { method: 'DELETE' }]);
    const failing = createHttpApi({
      fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    await expect(failing.removeDoc('a')).rejects.toBeInstanceOf(ApiError);
  });

  test('getSummary reads the summary endpoint and validates the reply', async () => {
    const urls: string[] = [];
    const fetchImpl = ((url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ status: 'pending' }));
    }) as typeof fetch;
    expect(await createHttpApi({ fetchImpl }).getSummary('a/b')).toEqual({
      status: 'pending',
    });
    expect(urls[0]).toBe('/api/docs/a%2Fb/summary');
    await expect(
      createHttpApi({
        fetchImpl: () => Promise.resolve(Response.json({ status: 'nope' })),
      }).getSummary('a'),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test('getSection encodes the section id', async () => {
    const urls: string[] = [];
    const fetchImpl = ((url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ bad: true }));
    }) as typeof fetch;
    await createHttpApi({ fetchImpl })
      .getSection('d', 'sec-4/b')
      .catch(() => undefined);
    expect(urls[0]).toBe('/api/docs/d/sections/sec-4%2Fb');
  });

  test('ingest POSTs JSON and yields validated events', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = ((_u: string, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(
        sseResponse(['data: {"type":"progress","stage":"fetching"}\n\n']),
      );
    }) as typeof fetch;
    const events = await collect(
      createHttpApi({ fetchImpl }).ingest({ url: 'https://e.gov/a' }),
    );
    expect(events).toEqual([{ type: 'progress', stage: 'fetching' }]);
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{"url":"https://e.gov/a"}');
  });

  test('ask surfaces HTTP errors before streaming', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json(
          { error: { code: 'RATE_LIMITED', message: 'Slow down.' } },
          { status: 429 },
        ),
      )) as typeof fetch;
    await expect(
      collect(createHttpApi({ fetchImpl }).ask('d', { chipId: 'summary' })),
    ).rejects.toThrow('Slow down.');
  });
});

describe('selectApi', () => {
  test('uses the mock for ?mock=1 or the env flag, the real client otherwise', () => {
    expect(selectApi('?mock=1').mock).toBe(true);
    expect(selectApi('', '1').mock).toBe(true);
    expect(selectApi('', '0').mock).toBeUndefined();
    expect(selectApi('?mock=0').mock).toBeUndefined();
  });

  test('?public=1 makes the mock a public server', async () => {
    const cfg = await selectApi('?mock=1&public=1').getConfig();
    expect(cfg.publicMode).toBe(true);
    expect(cfg.freeformEnabled).toBe(false);
  });
});
