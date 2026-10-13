import { act, screen } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BRAND } from '../core/brand.js';

vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  return { ...actual, createRoot: vi.fn(actual.createRoot) };
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  act(() => {
    for (const result of vi.mocked(createRoot).mock.results) {
      if (result.type === 'return') result.value.unmount();
    }
  });
  vi.clearAllMocks();
  document.body.replaceChildren();
});

test('bootstraps the UI and sets the browser title from the brand', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import('./main.js');
  });
  expect(document.title).toBe(BRAND.displayName);
  expect(screen.getByRole('heading', { name: BRAND.displayName })).toBeTruthy();
});

test('fails clearly when the HTML mount point is missing', async () => {
  await expect(import('./main.js')).rejects.toThrow('Missing root element.');
});
