import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { BRAND } from '../core/brand.js';
import { LogoMark } from './LogoMark.js';

afterEach(cleanup);

test('is an image labelled with the product name, at the requested size', () => {
  render(<LogoMark size={48} />);
  const mark = screen.getByRole('img', { name: BRAND.displayName });
  expect(mark.getAttribute('width')).toBe('48');
  expect(mark.getAttribute('viewBox')).toBe('0 0 32 32');
});
