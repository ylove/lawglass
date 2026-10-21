// No endless spinners: request deadlines, the stream silence watchdog, and the retry buttons.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { anySignal, createHttpApi } from './api.js';
import { CitationDrawer } from './CitationDrawer.js';
import { App } from './App.js';
import { DocumentView } from './DocumentView.js';
import { SummaryPanel } from './document/SummaryPanel.js';
import { readSseEvents } from './sse.js';
import { createMockApi } from './mock-api.js';
import type { ApiClient } from './api.js';
import { ApiError } from './sse.js';

const TOO_SLOW = 'The server took too long to answer. Please try again.';
const LOST = 'The connection to the server was lost. Please try again.';
const enc = new TextEncoder();
const Tok = z.object({ type: z.literal('token'), text: z.string() });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A fetch that never answers but, like the real one, rejects when its signal aborts. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  })) as unknown as typeof fetch;

describe('request timeouts', () => {
  test('a JSON request that never answers fails after 30 s with a plain message', async () => {
    const api = createHttpApi({ fetchImpl: hangingFetch });
    const result = api.getDoc('d1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await result;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('TIMEOUT');
    expect((err as ApiError).message).toBe(TOO_SLOW);
  });

  test('the summary request waits at least 35 s', async () => {
    const api = createHttpApi({ fetchImpl: hangingFetch });
    let settled = false;
    void api.getSummary('d1').catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
  });

  test('the deadline can be changed', async () => {
    const api = createHttpApi({ fetchImpl: hangingFetch, timeoutMs: 1000 });
    const result = api.getDoc('d1').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(((await result) as ApiError).code).toBe('TIMEOUT');
  });

  test('a caller abort stays an abort, not a timeout', async () => {
    const api = createHttpApi({ fetchImpl: hangingFetch });
    const caller = new AbortController();
    const result = api
      .getScenario('d1', { subject: 'x' }, caller.signal)
      .catch((e: unknown) => e);
    caller.abort();
    const err = await result;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  test('anySignal follows either source', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = anySignal(a.signal, b.signal);
    expect(merged.aborted).toBe(false);
    b.abort();
    expect(merged.aborted).toBe(true);
    const c = new AbortController();
    c.abort();
    expect(anySignal(c.signal, new AbortController().signal).aborted).toBe(
      true,
    );
    expect(anySignal(undefined, a.signal)).toBe(a.signal);
  });

  test('anySignal falls back when AbortSignal.any is missing', () => {
    const original: unknown = (AbortSignal as { any?: unknown }).any;
    // Simulating an older browser.
    (AbortSignal as { any?: unknown }).any = undefined;
    try {
      const a = new AbortController();
      const b = new AbortController();
      const merged = anySignal(a.signal, b.signal);
      a.abort();
      expect(merged.aborted).toBe(true);
      const done = new AbortController();
      done.abort();
      expect(anySignal(done.signal, b.signal).aborted).toBe(true);
    } finally {
      (AbortSignal as { any?: unknown }).any = original;
    }
  });
});

/** A response whose body the test feeds by hand. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body),
    push: (text: string) => {
      controller.enqueue(enc.encode(text));
    },
  };
}

describe('stream watchdog', () => {
  test('45 s of silence ends the stream with a connection-lost error', async () => {
    const { response } = liveStream();
    const it = readSseEvents(response, Tok);
    const next = it.next().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(44_999);
    let settled = false;
    void next.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await next;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(LOST);
  });

  test('heartbeat comments reset the watchdog', async () => {
    const { response, push } = liveStream();
    const it = readSseEvents(response, Tok);
    const next = it.next().catch((e: unknown) => e);
    // 5 x 40 s = 200 s in total, but never 45 s without a byte.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(40_000);
      push(': keep-alive\n\n');
    }
    push('data: {"type":"token","text":"hi"}\n\n');
    expect(await next).toEqual({
      done: false,
      value: { type: 'token', text: 'hi' },
    });
  });

  test('the idle limit is configurable', async () => {
    const { response } = liveStream();
    const next = readSseEvents(response, Tok, { idleMs: 100 })
      .next()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(((await next) as ApiError).message).toBe(LOST);
  });

  test('a stream that never starts answering also fails', async () => {
    const api = createHttpApi({ fetchImpl: hangingFetch });
    const next = api
      .ask('d1', { question: 'q' }, undefined)
      [Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(((await next) as ApiError).message).toBe(TOO_SLOW);
  });
});

function failing(overrides: Partial<ApiClient>): ApiClient {
  return { ...createMockApi({ delayMs: 0 }), ...overrides };
}

describe('error bodies and startup', () => {
  test('a failing stream whose error body stalls still times out', async () => {
    const stalled = ((_u: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init?.signal?.addEventListener('abort', () => {
            c.error(new DOMException('aborted', 'AbortError'));
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 503 }));
    }) as unknown as typeof fetch;
    const api = createHttpApi({ fetchImpl: stalled });
    const next = api
      .ask('d1', { question: 'q' })
      [Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(((await next) as ApiError).code).toBe('TIMEOUT');
  });

  test('a startup timeout shows Retry, and Retry recovers', async () => {
    const base = createMockApi({ delayMs: 0 });
    let calls = 0;
    const api = failing({
      getConfig: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new ApiError('TIMEOUT', TOO_SLOW))
          : base.getConfig();
      },
    });
    render(<App api={api} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText(TOO_SLOW)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.queryByText(TOO_SLOW)).toBeNull();
    expect(calls).toBe(2);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('retry buttons', () => {
  test('the drawer shows the error with Retry, and Retry loads the section', async () => {
    let calls = 0;
    const base = createMockApi({ delayMs: 0 });
    const [doc] = await base.listDocs();
    const detail = await base.getDoc(doc!.docId);
    const sectionId = detail.outline[0]!.id;
    const api = failing({
      getSection: (d, s) => {
        calls++;
        return calls === 1
          ? Promise.reject(new ApiError('TIMEOUT', TOO_SLOW))
          : base.getSection(d, s);
      },
    });
    render(
      <CitationDrawer
        api={api}
        docId={doc!.docId}
        sectionId={sectionId}
        hasLineNumbers
        returnFocusTo={null}
        onClose={() => undefined}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole('alert').textContent).toContain(TOO_SLOW);
    expect(screen.queryByText('Loading the section...')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByText(TOO_SLOW)).toBeNull();
    expect(calls).toBe(2);
    expect(screen.getByText('Source text')).toBeTruthy();
  });

  test('the document view shows Retry when loading fails, and Retry reloads', async () => {
    let calls = 0;
    const base = createMockApi({ delayMs: 0 });
    const [doc] = await base.listDocs();
    const api = failing({
      getDoc: (id) => {
        calls++;
        return calls === 1
          ? Promise.reject(new ApiError('TIMEOUT', TOO_SLOW))
          : base.getDoc(id);
      },
    });
    const config = await base.getConfig();
    render(<DocumentView api={api} config={config} docId={doc!.docId} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole('alert').textContent).toContain(TOO_SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toBe(2);
    expect(screen.queryByText(TOO_SLOW)).toBeNull();
    expect(screen.queryByText('Loading the document...')).toBeNull();
  });

  test('the summary panel offers a gentle retry after giving up', async () => {
    let calls = 0;
    const api = failing({
      getSummary: () => {
        calls++;
        return Promise.reject(new ApiError('TIMEOUT', TOO_SLOW));
      },
    });
    render(
      <SummaryPanel
        api={api}
        docId="d"
        preview={undefined}
        officialSummary={undefined}
        publicMode={false}
        onOpenSection={() => undefined}
        pollMs={10}
        maxWaitMs={50}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(
      screen.getByText(/The summary could not be loaded right now/),
    ).toBeTruthy();
    const before = calls;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(calls).toBe(before + 1);
    expect(screen.getByText('Writing a plain-language summary…')).toBeTruthy();
  });

  test('a summary that stays pending shows the slow note with Try again', async () => {
    const api = failing({
      getSummary: () => Promise.resolve({ status: 'pending' } as never),
    });
    render(
      <SummaryPanel
        api={api}
        docId="d"
        preview={undefined}
        officialSummary={undefined}
        publicMode={false}
        onOpenSection={() => undefined}
        pollMs={10}
        maxWaitMs={50}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText(/taking longer than expected/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
