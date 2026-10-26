import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ReadingLevel } from './ReadingLevel.js';

afterEach(cleanup);

test('shows the rounded grade', () => {
  render(
    <ReadingLevel
      answer={{ readingGrade: 7.4, declined: false, simplified: undefined }}
    />,
  );
  expect(screen.getByText('Reading level: grade 7')).toBeTruthy();
});

test('says simplified when the text was rewritten', () => {
  render(
    <ReadingLevel
      answer={{ readingGrade: 6.6, declined: false, simplified: true }}
    />,
  );
  expect(screen.getByText('Reading level: grade 7 (simplified)')).toBeTruthy();
});

test('shows nothing for a decline or an unmeasured answer, and never a grade below 1', () => {
  const { container, rerender } = render(
    <ReadingLevel
      answer={{ readingGrade: 5, declined: true, simplified: undefined }}
    />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <ReadingLevel
      answer={{ readingGrade: null, declined: false, simplified: undefined }}
    />,
  );
  expect(container.textContent).toBe('');
  rerender(
    <ReadingLevel
      answer={{ readingGrade: -2.3, declined: false, simplified: undefined }}
    />,
  );
  expect(container.textContent).toBe('Reading level: grade 1');
});

test('shows nothing for a chip answered from stored data (provider none)', () => {
  const { container } = render(
    <ReadingLevel
      answer={{
        readingGrade: 4,
        declined: false,
        simplified: undefined,
        provider: 'none',
      }}
    />,
  );
  expect(container.textContent).toBe('');
});
