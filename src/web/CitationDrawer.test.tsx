import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import type { SectionExcerpt } from '../core/model/index.js';
import type { ApiClient } from './api.js';
import { CitationDrawer, ExcerptSpans } from './CitationDrawer.js';

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

function drawerFor(excerpt: SectionExcerpt) {
  const api = {
    getSection: () => Promise.resolve(excerpt),
  } as unknown as ApiClient;
  return render(
    <CitationDrawer
      api={api}
      docId="d"
      sectionId={excerpt.sectionId}
      hasLineNumbers
      returnFocusTo={null}
      onClose={() => undefined}
    />,
  );
}

test('shows the official-source line and no page, line or amendment legend for a reference', async () => {
  drawerFor({
    sectionId: 'ref:usc/15/6809',
    breadcrumb: "15 U.S.C. 6809 (U.S. Code, read for 'financial institution')",
    heading: '§6809. Definitions',
    spans: [
      {
        text: 'The term "financial institution" means any institution.',
        status: 'unchanged',
      },
    ],
    location: {},
    reference: {
      citation: '15 U.S.C. 6809',
      url: 'https://www.govinfo.gov/link/uscode/15/6809?link-type=html',
    },
  });
  await waitFor(() => {
    expect(
      screen.getByText(/From the U\.S\. Code \(official source\)/),
    ).toBeTruthy();
  });
  const link = screen.getByRole<HTMLAnchorElement>('link', {
    name: '15 U.S.C. 6809',
  });
  expect(link.href).toBe(
    'https://www.govinfo.gov/link/uscode/15/6809?link-type=html',
  );
  expect(link.target).toBe('_blank');
  expect(link.rel).toBe('noopener noreferrer');
  expect(screen.getByText(/means any institution/)).toBeTruthy();
  expect(screen.queryByText(/Page|lines|Section-only/)).toBeNull();
  expect(screen.queryByText(/Struck-through text/)).toBeNull();
});

test('a bill section keeps its location and legend', async () => {
  drawerFor({
    sectionId: 'sec-1',
    breadcrumb: 'Sec. 1',
    spans: [{ text: 'Text.', status: 'unchanged' }],
    location: { pageStart: 2, lineStart: 5 },
  });
  await waitFor(() => {
    expect(screen.getByText('Page 2, line 5')).toBeTruthy();
  });
  expect(screen.getByText(/Struck-through text/)).toBeTruthy();
  expect(screen.queryByText(/official source/)).toBeNull();
});
