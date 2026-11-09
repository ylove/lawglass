import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createHttpApi, type ApiClient } from './api.js';
import { App } from './App.js';
import {
  EVENT_TYPE,
  emitEvent,
  withEvents,
  type ReaderEvent,
} from './events.js';
import { createMockApi } from './mock-api.js';
import { SAMPLE_PATH, visit } from '../../tests/support/web-routes.js';
import {
  CANCELLED,
  parseQuote,
  QuoteDialog,
  withQuoteConfirmation,
} from './quote.js';
import { ApiError } from './sse.js';

afterEach(cleanup);

let events: ReaderEvent[];
const listener = (e: Event): void => {
  events.push((e as CustomEvent<ReaderEvent>).detail);
};
beforeEach(() => {
  visit(SAMPLE_PATH);
  events = [];
  window.addEventListener(EVENT_TYPE, listener);
  return () => {
    window.removeEventListener(EVENT_TYPE, listener);
  };
});

const HOST_QUOTE = {
  quoteId: 'q-123',
  display: 'Reading this bill costs $2.50.',
  facts: { pages: 12, sections: 40, tokens: 50_000, mode: 'whole', units: 9 },
  secretFromHost: 'ignored',
};
const payment = () =>
  new ApiError('PAYMENT_REQUIRED', 'Confirm the quote.', HOST_QUOTE);

describe('parseQuote', () => {
  test('keeps what it knows and drops the rest; garbage becomes an empty quote', () => {
    expect(parseQuote(HOST_QUOTE)).toEqual({
      quoteId: 'q-123',
      display: HOST_QUOTE.display,
      facts: HOST_QUOTE.facts,
    });
    for (const junk of [
      null,
      'x',
      7,
      { quoteId: 5 },
      { display: 'x'.repeat(501) },
    ])
      expect(parseQuote(junk)).toEqual({});
  });
});

describe('a 402 reaches the SPA with its quote', () => {
  test('the HTTP client keeps the host quote on the error', async () => {
    const api = createHttpApi({
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'PAYMENT_REQUIRED', message: 'Confirm.' },
              quote: HOST_QUOTE,
            }),
            { status: 402, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    const error = await (async () => {
      const out: unknown[] = [];
      for await (const e of api.ingest({ url: 'https://example.gov/a' }))
        out.push(e);
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PAYMENT_REQUIRED');
    expect((error as ApiError).quote).toEqual(HOST_QUOTE);
  });
});

describe('withQuoteConfirmation', () => {
  const fake = (ask: ApiClient['ask']): ApiClient => ({
    ...createMockApi(),
    ask,
  });
  const drain = async (it: AsyncIterable<unknown>) => {
    const out: unknown[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  test('resubmits once with the quote id after the reader confirms', async () => {
    const seen: (string | undefined)[] = [];
    const api = withQuoteConfirmation(
      fake(async function* (_doc, req) {
        await Promise.resolve();
        seen.push(req.quoteId);
        if (!req.quoteId) throw payment();
        yield { type: 'token' as const, text: 'ok' };
      }),
      () => Promise.resolve(true),
    );
    await drain(api.ask('d', { chipId: 'summary' }));
    expect(seen).toEqual([undefined, 'q-123']);
    expect(events.map((e) => e.name)).toEqual([
      'quote_shown',
      'quote_confirmed',
    ]);
  });

  test('a host quote id the server would refuse is reported, not resubmitted', async () => {
    let calls = 0;
    const api = withQuoteConfirmation(
      fake(async function* () {
        await Promise.resolve();
        calls++;
        throw new ApiError('PAYMENT_REQUIRED', 'Confirm.', {
          quoteId: 'q+abc/def==',
          display: '$1',
        });
        yield { type: 'token' as const, text: '' };
      }),
      () => Promise.resolve(true),
    );
    await expect(
      drain(api.ask('d', { chipId: 'summary' })),
    ).rejects.toMatchObject({
      code: 'INVALID_QUOTE',
    });
    expect(calls).toBe(1);
  });

  test('cancelling stops with a plain message and never resubmits', async () => {
    let calls = 0;
    const api = withQuoteConfirmation(
      fake(async function* () {
        await Promise.resolve();
        calls++;
        throw payment();
        yield { type: 'token' as const, text: '' };
      }),
      () => Promise.resolve(false),
    );
    await expect(
      drain(api.ask('d', { chipId: 'summary' })),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
      message: CANCELLED,
    });
    expect(calls).toBe(1);
    expect(events.map((e) => e.name)).toEqual(['quote_shown']);
  });

  test('a second 402 after confirming is an error, not another dialog', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const api = withQuoteConfirmation(
      fake(async function* () {
        await Promise.resolve();
        throw payment();
        yield { type: 'token' as const, text: '' };
      }),
      confirm,
    );
    await expect(
      drain(api.ask('d', { chipId: 'summary' })),
    ).rejects.toMatchObject({
      code: 'PAYMENT_REQUIRED',
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test('other errors pass through untouched', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const api = withQuoteConfirmation(
      fake(async function* () {
        await Promise.resolve();
        throw new ApiError('RATE_LIMITED', 'Slow down.');
        yield { type: 'token' as const, text: '' };
      }),
      confirm,
    );
    await expect(
      drain(api.ask('d', { chipId: 'summary' })),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('QuoteDialog', () => {
  test('shows size facts and the host text, never a price of its own', () => {
    render(
      <QuoteDialog
        quote={parseQuote(HOST_QUOTE)}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm before we start',
    });
    expect(dialog.textContent).toContain(
      '12 pages, 40 sections, about 40,000 words',
    );
    expect(dialog.textContent).toContain('Reading this bill costs $2.50.');
  });

  test('without host text there is no price, only the facts', () => {
    render(
      <QuoteDialog
        quote={parseQuote({ facts: { sections: 1 } })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const text = screen.getByRole('dialog').textContent;
    expect(text).toContain('1 section');
    expect(text).not.toContain('$');
  });

  test('focuses Confirm; Escape cancels', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <QuoteDialog quote={{}} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Confirm' }),
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('in the app', () => {
  function quotedApi() {
    const api = createMockApi({ delayMs: 0 });
    const ask = api.ask.bind(api);
    const seen: (string | undefined)[] = [];
    api.ask = (docId, req, signal) => {
      seen.push(req.quoteId);
      if (!req.quoteId)
        return (async function* () {
          await Promise.resolve();
          throw payment();
        })();
      return ask(docId, req, signal);
    };
    return { api, seen };
  }

  test('a quoted question waits for Confirm, then runs with the quote id', async () => {
    const { api, seen } = quotedApi();
    render(<App api={api} />);
    await screen.findByRole('heading', {
      name: 'Clean Water Infrastructure Act',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'What does it change?' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm before we start',
    });
    expect(dialog.textContent).toContain('Reading this bill costs $2.50.');
    expect(seen).toEqual([undefined]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Sources' });
    expect(seen).toEqual([undefined, 'q-123']);
    expect(
      screen.queryByRole('dialog', { name: 'Confirm before we start' }),
    ).toBeNull();
  });

  test('cancelling closes the dialog and says so', async () => {
    const { api, seen } = quotedApi();
    render(<App api={api} />);
    await screen.findByRole('heading', {
      name: 'Clean Water Infrastructure Act',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'What does it change?' }),
    );
    await screen.findByRole('dialog', { name: 'Confirm before we start' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.getByText(CANCELLED)).toBeTruthy();
    });
    expect(seen).toEqual([undefined]);
  });
});

describe('reader events', () => {
  test('dispatches the neutral events for the key actions, and none carries text or an address', async () => {
    const secretQuestion = 'Does my landlord secretly owe me money?';
    const secretSentence = 'Senator Quimby promised free pie to everyone';
    const secretUrl = 'https://private.example/my-own-bill.pdf';
    render(<App api={createMockApi({ delayMs: 0 })} />);
    await screen.findByRole('heading', {
      name: 'Clean Water Infrastructure Act',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'What does it change?' }),
    );
    await screen.findByRole('heading', { name: 'Sources' });
    fireEvent.change(screen.getByLabelText('Or ask your own question'), {
      target: { value: secretQuestion },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => {
      expect(events.filter((e) => e.name === 'question_asked')).toHaveLength(2);
    });
    fireEvent.change(screen.getByLabelText(/Paste a sentence/), {
      target: { value: secretSentence },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find passage' }));
    await waitFor(() => {
      expect(events.some((e) => e.name === 'find_where_it_says')).toBe(true);
    });
    const names = events.map((e) => e.name);
    expect(names).toContain('question_asked');
    expect(
      events.find((e) => e.name === 'question_asked' && e.chipId)?.chipId,
    ).toBeTruthy();
    const typed = events.filter(
      (e) => e.name === 'question_asked' && !e.chipId,
    );
    expect(typed).toHaveLength(1);
    // Whatever the events carry, it is neither the question, the sentence, nor an address.
    const wire = JSON.stringify(events);
    for (const text of [
      secretQuestion,
      secretSentence,
      secretUrl,
      'landlord',
      'Quimby',
      'private.example',
    ])
      expect(wire).not.toContain(text);
    for (const e of events)
      for (const value of Object.values(e))
        expect(['string', 'number', 'boolean']).toContain(typeof value);
  });

  test('opening a source passage is a section_brief_open event', async () => {
    render(<App api={createMockApi({ delayMs: 0 })} />);
    await screen.findByRole('heading', {
      name: 'Clean Water Infrastructure Act',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'What does it change?' }),
    );
    await screen.findByRole('heading', { name: 'Sources' });
    fireEvent.click(screen.getByRole('button', { name: /Section 4 > \(b\)/ }));
    await screen.findByRole('dialog', { name: 'Source text' });
    expect(events.filter((e) => e.name === 'section_brief_open')).toHaveLength(
      1,
    );
  });

  test('a cached summary and a drawn example are each reported once per document', async () => {
    const base = createMockApi();
    const api = withEvents({
      ...base,
      getDoc: () =>
        Promise.resolve({
          ...({} as Awaited<ReturnType<ApiClient['getDoc']>>),
          metadata: { jurisdiction: 'Ohio' } as never,
        }),
      getSummary: () => Promise.resolve({ status: 'cached' as const }),
      getSectionExample: () => Promise.resolve({ status: 'ok' as const }),
    });
    await api.getDoc('d1');
    await api.getSummary('d1');
    await api.getSummary('d1');
    await api.getSectionExample('d1', 's1');
    await api.getSectionExample('d1', 's1');
    await api.getSectionExample('d1', 's2');
    expect(events).toEqual([
      { name: 'summary_viewed', jurisdiction: 'ohio' },
      { name: 'example_view', jurisdiction: 'ohio' },
      { name: 'example_view', jurisdiction: 'ohio' },
    ]);
  });

  test('ingest events name no address', async () => {
    const api = createMockApi({ delayMs: 0 });
    render(<App api={api} />);
    await screen.findByRole('heading', {
      name: 'Clean Water Infrastructure Act',
    });
    visit('/');
    cleanup();
    render(<App api={api} />);
    const input = await screen.findByLabelText('Web address of the bill');
    fireEvent.change(input, {
      target: { value: 'https://private.example/my-own-bill.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Read this bill' }));
    await waitFor(() => {
      expect(events.some((e) => e.name === 'ingest_done')).toBe(true);
    });
    expect(events.map((e) => e.name)).toContain('ingest_started');
    expect(JSON.stringify(events)).not.toContain('private.example');
    const done = events.find((e) => e.name === 'ingest_done');
    expect(done).toMatchObject({
      size: expect.any(String) as string,
      reused: expect.any(Boolean) as boolean,
    });
  });

  test('emitEvent is an allowlist: unlisted fields and unlisted values never leave', () => {
    emitEvent('question_asked', {
      jurisdiction: 'State of Ohio',
      chipId: 'penalties',
      format: 'pdf', // not allowed on this event
      question: 'Can my landlord evict me?',
      url: 'https://example.gov/bill',
    } as never);
    emitEvent('question_asked', {
      jurisdiction: 'jane.doe.example.com',
      chipId: 'can my landlord evict me',
    });
    emitEvent('ingest_done', {
      format: 'pdf',
      size: 'a very long free text label here',
      reused: 'yes',
    });
    emitEvent('quote_shown', { jurisdiction: 'Ohio' });
    expect(events).toEqual([
      { name: 'question_asked', jurisdiction: 'ohio', chipId: 'penalties' },
      { name: 'question_asked', jurisdiction: 'other' },
      { name: 'ingest_done', format: 'pdf' },
      { name: 'quote_shown' },
    ]);
  });

  test('a throwing host listener cannot break the page', () => {
    const bad = () => {
      throw new Error('host bug');
    };
    window.addEventListener(EVENT_TYPE, bad);
    expect(() => {
      emitEvent('summary_viewed');
    }).not.toThrow();
    window.removeEventListener(EVENT_TYPE, bad);
  });
});

export type { z };
