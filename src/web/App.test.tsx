import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BRAND } from '../core/brand.js';
import { App } from './App.js';
import { createMockApi } from './mock-api.js';

afterEach(cleanup);

test('renders the brand and the legal disclaimer', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: BRAND.displayName })).toBeTruthy();
  const disclaimer = screen.getByText(
    'Not legal advice. Answers are generated only from the text of this document.',
  );
  expect(disclaimer.closest('footer')).not.toBeNull();
});

test.each([undefined, '/account?tab=billing'])(
  'shows an Account link only when config supplies a URL (%s)',
  async (accountUrl) => {
    const api = createMockApi();
    const config = await api.getConfig();
    vi.spyOn(api, 'getConfig').mockResolvedValue({
      ...config,
      ...(accountUrl ? { accountUrl } : {}),
    });
    render(<App api={api} />);
    await screen.findByRole('heading', { name: 'Your documents' });
    if (accountUrl)
      expect(
        screen.getByRole('link', { name: 'Account' }).getAttribute('href'),
      ).toBe(accountUrl);
    else expect(screen.queryByRole('link', { name: 'Account' })).toBeNull();
  },
);
