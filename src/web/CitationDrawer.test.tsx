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

test('lets links inside struck or added drawer text inherit the amendment ink', async () => {
  // `.excerpt a` sets the accent color; the override must be at least as specific, or links on
  // the amber/blue fills drop under 4.5:1 in light mode.
  const { readFile } = await import('node:fs/promises');
  // Vitest runs from the repo root; happy-dom gives import.meta.url an http scheme.
  const css = await readFile('src/web/styles/reading.css', 'utf8');
  expect(css).toMatch(
    /\.excerpt del a,\s*\.excerpt ins a,[^{]*\{\s*color: inherit;/,
  );
});
