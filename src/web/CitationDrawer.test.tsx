import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ExcerptSpans } from './CitationDrawer.js';

afterEach(cleanup);

test('drawer text links .gov URLs, including inside added text, and nothing else', () => {
  const { container } = render(
    <ExcerptSpans
      spans={[
        { text: 'See https://congress.gov/x, and ', status: 'unchanged' },
        { text: 'https://www.ohio.gov/a', status: 'inserted' },
        { text: ' not https://gov.evil.com/b', status: 'deleted' },
      ]}
    />,
  );
  expect(
    Array.from(container.querySelectorAll('a')).map((a) =>
      a.getAttribute('href'),
    ),
  ).toEqual(['https://congress.gov/x', 'https://www.ohio.gov/a']);
  expect(container.querySelector('ins a')).toBeTruthy();
  expect(container.querySelector('del a')).toBeNull();
});
