// The question mode choice (issue #429), driven through the scripted mock API.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SAMPLE_PATH, visit } from '../../tests/support/web-routes.js';
import type { QuestionQuote } from '../core/answer/question-quote.js';
import { App } from './App.js';
import { createHttpApi, type ApiClient } from './api.js';
import {
  QuestionModeDialog,
  needsModeChoice,
} from './document/QuestionModeDialog.js';
import { createMockApi, MOCK_QUESTION_QUOTE } from './mock-api.js';

beforeEach(() => {
  visit(SAMPLE_PATH);
});
afterEach(cleanup);

/**
 * A mock API whose ask is spied. `quote` null means the server has no hook (the config then does
 * not offer the quote); 'fails' means a hook exists but the quote request errors.
 */
function setup(quote: QuestionQuote | null | 'fails') {
  const mock = createMockApi({
    delayMs: 0,
    ...(quote
      ? { questionQuote: quote === 'fails' ? MOCK_QUESTION_QUOTE : quote }
      : {}),
  });
  const ask = vi.spyOn(mock, 'ask');
  const getQuestionQuote = vi.fn(() =>
    quote === 'fails'
      ? Promise.reject(new Error('down'))
      : Promise.resolve({ quote }),
  );
  const api: ApiClient = { ...mock, ask, getQuestionQuote };
  return { api, ask, getQuestionQuote };
}

async function typeQuestion(text = 'Who pays?') {
  const input = await screen.findByLabelText('Or ask your own question');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  return input;
}

describe('asking with no host hook', () => {
  test('asks directly, with no dialog, no mode and no quote request', async () => {
    const { api, ask, getQuestionQuote } = setup(null);
    render(<App api={api} />);
    await typeQuestion();
    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });
    expect(ask.mock.calls[0]?.[1]).toEqual({ question: 'Who pays?' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getQuestionQuote).not.toHaveBeenCalled();
  });

  test('a quote that could not be fetched asks FOCUSED, never auto', async () => {
    const { api, ask } = setup('fails');
    render(<App api={api} />);
    await typeQuestion();
    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });
    expect(ask.mock.calls[0]?.[1]).toEqual({
      question: 'Who pays?',
      mode: 'focused',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('chips never ask for a quote', async () => {
    const { api, ask, getQuestionQuote } = setup(MOCK_QUESTION_QUOTE);
    render(<App api={api} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Who does it affect?' }),
    );
    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });
    expect(getQuestionQuote).not.toHaveBeenCalled();
    expect(ask.mock.calls[0]?.[1]).toEqual({ chipId: 'who-affected' });
  });
});

describe('asking when both modes cost the same', () => {
  test.each([
    ['equal', { whole: { units: 1 }, focused: { units: 1 } }],
    ['no whole read exists', { focused: { units: 1 } }],
    ['whole is cheaper', { whole: { units: 1 }, focused: { units: 2 } }],
  ])('%s: asks directly', async (_name, quote) => {
    const { api, ask } = setup(quote);
    render(<App api={api} />);
    await typeQuestion();
    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });
    expect(ask.mock.calls[0]?.[1]).toEqual({ question: 'Who pays?' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('asking when a whole-bill read costs more', () => {
  test('shows both choices with their units and sends nothing yet', async () => {
    const { api, ask } = setup(MOCK_QUESTION_QUOTE);
    render(<App api={api} />);
    await typeQuestion();
    const dialog = await screen.findByRole('dialog', {
      name: 'How much of the bill should we read?',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('uses 4 of your 30 questions');
    expect(dialog.textContent).toContain('uses 1 question');
    // The cheaper choice is first and the filled primary; the costlier one is secondary.
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => dialog.contains(b));
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Get a focused answer (1 question)',
      'Read the whole bill (4 questions)',
      'Cancel',
    ]);
    expect(buttons[0]?.className).toContain('primary');
    expect(buttons[1]?.className).not.toContain('primary');
    expect(
      screen.getByRole('button', { name: 'Read the whole bill (4 questions)' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Get a focused answer (1 question)' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(ask).not.toHaveBeenCalled();
    // Focus starts on the title, not on a button that would spend something.
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: /How much of the bill/ }),
    );
  });

  test('the focused choice asks with mode focused', async () => {
    const { api, ask } = setup(MOCK_QUESTION_QUOTE);
    render(<App api={api} />);
    await typeQuestion();
    fireEvent.click(
      await screen.findByRole('button', { name: /Get a focused answer/ }),
    );
    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });
    expect(ask.mock.calls[0]?.[1]).toEqual({
      question: 'Who pays?',
      mode: 'focused',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the whole choice asks with mode whole', async () => {
    const { api, ask } = setup(MOCK_QUESTION_QUOTE);
    render(<App api={api} />);
    await typeQuestion();
    fireEvent.click(
      await screen.findByRole('button', { name: /Read the whole bill/ }),
    );
    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });
    expect(ask.mock.calls[0]?.[1]).toEqual({
      question: 'Who pays?',
      mode: 'whole',
    });
  });

  test('cancel and Escape send nothing and return focus to the question box', async () => {
    const { api, ask } = setup(MOCK_QUESTION_QUOTE);
    render(<App api={api} />);
    const input = await typeQuestion();
    input.focus();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(input);

    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('QuestionModeDialog', () => {
  const quote: QuestionQuote = { whole: { units: 5 }, focused: { units: 2 } };
  const show = () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    render(
      <QuestionModeDialog
        quote={quote}
        onChoose={onChoose}
        onCancel={onCancel}
      />,
    );
    return { onChoose, onCancel };
  };

  test('says "units" when the host gave no label and omits the allowance', () => {
    show();
    const text = screen.getByRole('dialog').textContent;
    expect(text).toContain('uses 5 units');
    expect(text).toContain('uses 2 units');
    expect(text).not.toContain('of your');
  });

  test('Tab wraps inside the dialog in both directions', () => {
    show();
    const first = screen.getByRole('button', { name: /Get a focused answer/ });
    const last = screen.getByRole('button', { name: 'Cancel' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('QuestionModeDialog from the title', () => {
  test('Shift+Tab from the title goes to the last button, Tab to the first', () => {
    render(
      <QuestionModeDialog
        quote={{ whole: { units: 5 }, focused: { units: 2 } }}
        onChoose={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const title = screen.getByRole('heading');
    expect(document.activeElement).toBe(title);
    fireEvent.keyDown(title, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Cancel' }),
    );
    title.focus();
    fireEvent.keyDown(title, { key: 'Tab' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Get a focused answer/ }),
    );
  });
});

describe('needsModeChoice', () => {
  test('only when a whole-bill read costs strictly more', () => {
    expect(needsModeChoice(null)).toBe(false);
    expect(needsModeChoice({ focused: { units: 1 } })).toBe(false);
    expect(
      needsModeChoice({ whole: { units: 1 }, focused: { units: 1 } }),
    ).toBe(false);
    expect(
      needsModeChoice({ whole: { units: 2 }, focused: { units: 1 } }),
    ).toBe(true);
  });
});

describe('http client', () => {
  test('posts to the document question-quote route and validates the answer', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          quote: { whole: { units: 4 }, focused: { units: 1 } },
        }),
      ),
    );
    const api = createHttpApi({ fetchImpl });
    const res = await api.getQuestionQuote('d'.repeat(64));
    expect(res.quote?.whole?.units).toBe(4);
    const [path, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe(`/api/docs/${'d'.repeat(64)}/question-quote`);
    expect(init.method).toBe('POST');
  });

  test('a null quote is how a server with no hook answers', async () => {
    const api = createHttpApi({
      fetchImpl: () => Promise.resolve(Response.json({ quote: null })),
    });
    expect((await api.getQuestionQuote('d'.repeat(64))).quote).toBeNull();
  });
});
