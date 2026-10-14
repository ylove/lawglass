import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AnswerBodyBoundary } from './AnswerBodyBoundary.js';
import * as AnswerModule from './AnswerText.js';
import { App } from './App.js';
import { createMockApi } from './mock-api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BrokenAnswer(): never {
  throw new Error('Answer render failed');
}

test('falls back to escaped plain text with literal citations, and keeps later text updates', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const text = '**Answer** <img src=x onerror=alert(1)>\n[S:sec-2]';
  const { container, rerender } = render(
    <AnswerBodyBoundary text={text}>
      <BrokenAnswer />
    </AnswerBodyBoundary>,
  );
  expect(container.textContent).toBe(text);
  expect(container.querySelector('p')?.style.whiteSpace).toBe('pre-wrap');
  expect(container.querySelector('img, strong, button')).toBeNull();
  rerender(
    <AnswerBodyBoundary text={`${text} More [S:sec-3]`}>
      <BrokenAnswer />
    </AnswerBodyBoundary>,
  );
  expect(container.textContent).toBe(`${text} More [S:sec-3]`);
});

test('a failing streamed answer keeps the document, plain final citations and source drawer usable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const renderer = vi
    .spyOn(AnswerModule, 'AnswerText')
    .mockImplementation(BrokenAnswer);
  const { container } = render(<App api={createMockApi({ delayMs: 0 })} />);
  await screen.findByRole('heading', {
    name: 'Clean Water Infrastructure Act',
  });
  const chip = screen.getByRole('button', { name: 'What does it change?' });
  fireEvent.click(chip);
  await waitFor(() => {
    expect(container.querySelector('.answer-body')?.textContent).toContain(
      '[S:',
    );
  });
  await screen.findByRole('heading', { name: 'Sources' });
  expect(
    screen.getByRole('heading', { name: 'Clean Water Infrastructure Act' }),
  ).toBeTruthy();
  expect(container.querySelector('.answer-body button')).toBeNull();
  const source = screen.getByRole('button', { name: /Section 4 > \(b\)/ });
  fireEvent.click(source);
  await screen.findByRole('dialog', { name: 'Source text' });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  // Starting another question resets the boundary, including when the label is repeated.
  renderer.mockRestore();
  fireEvent.click(chip);
  await screen.findAllByRole('button', { name: 'Source 1' });
  expect(container.querySelector('.answer-body')?.textContent).not.toContain(
    '[S:',
  );
});

test('a final answer render failure shows the full answer with plain citation markers', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const original = AnswerModule.AnswerText;
  vi.spyOn(AnswerModule, 'AnswerText').mockImplementation((props) => {
    if (props.citations.length > 0) return BrokenAnswer();
    return original(props);
  });
  const { container } = render(<App api={createMockApi({ delayMs: 0 })} />);
  await screen.findByRole('heading', {
    name: 'Clean Water Infrastructure Act',
  });
  fireEvent.click(screen.getByRole('button', { name: 'What does it change?' }));
  await screen.findByRole('heading', { name: 'Sources' });
  expect(container.querySelector('.answer-body')?.textContent).toContain(
    '[S:sec-4/b]',
  );
  expect(container.querySelector('.answer-body')?.textContent).toContain(
    'shortens the deadline',
  );
  expect(container.querySelector('.answer-body button')).toBeNull();
});
