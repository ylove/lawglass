import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SummarySlot } from './SummarySlot.js';

it('renders no DOM until the summary exists', () => {
  const { container } = render(<SummarySlot />);
  expect(container.innerHTML).toBe('');
});
