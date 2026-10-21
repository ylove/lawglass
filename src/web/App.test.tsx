import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { BRAND } from '../core/brand.js';
import { App } from './App.js';

afterEach(cleanup);

test('renders the brand and the legal disclaimer', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: BRAND.displayName })).toBeTruthy();
  const disclaimer = screen.getByText(
    'Not legal advice. Answers are generated only from the text of this document.',
  );
  expect(disclaimer.closest('footer')).not.toBeNull();
});
