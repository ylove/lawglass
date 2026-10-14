import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { BRAND } from '../core/brand.js';
import { App } from './App.js';
import { createMockApi } from './mock-api.js';

afterEach(cleanup);

test('the bill title sits in the masthead band, and the h1 stays the product name', async () => {
  render(<App api={createMockApi({ delayMs: 0 })} />);
  const title = await screen.findByRole('heading', {
    name: 'Clean Water Infrastructure Act',
  });
  expect(screen.getByRole('banner').contains(title)).toBe(true);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
    BRAND.displayName,
  );
});

test('the home screen shows the hero line outside the h1', async () => {
  const api = createMockApi({ delayMs: 0 });
  api.listDocs = () => Promise.resolve([]);
  render(<App api={api} />);
  const hero = await screen.findByText('Understand any bill, line by line.');
  expect(hero.tagName).toBe('P');
  expect(screen.getByRole('banner').contains(hero)).toBe(true);
});

test('the chip for the current question is marked pressed', async () => {
  render(<App api={createMockApi({ delayMs: 0 })} />);
  await screen.findByRole('heading', {
    name: 'Clean Water Infrastructure Act',
  });
  const chip = screen.getByRole('button', { name: 'What does it change?' });
  expect(chip.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(chip);
  await screen.findAllByRole('button', { name: 'Source 1' });
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  expect(
    screen
      .getByRole('button', { name: 'Key definitions' })
      .getAttribute('aria-pressed'),
  ).toBe('false');
});
