import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SectionBrief } from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { createMockApi } from '../mock-api.js';
import { ApiError } from '../sse.js';
import { SectionExample } from './SectionExample.js';

afterEach(cleanup);

const brief = (id: string): SectionBrief => ({
  sectionId: id,
  text: `Text ${id}.`,
  citations: [],
  readingGrade: 5,
  example: 'available',
});

describe('SectionExample automatic retry', () => {
  test('a success re-arms the one automatic retry', async () => {
    const api = createMockApi({ delayMs: 0 });
    const example = vi
      .fn<ApiClient['getSectionExample']>()
      .mockRejectedValueOnce(new ApiError('PROVIDER_ERROR', 'x'))
      .mockResolvedValueOnce({ status: 'none', note: 'Nothing here.' })
      .mockRejectedValueOnce(new ApiError('PROVIDER_ERROR', 'x'))
      .mockResolvedValue({ status: 'none', note: 'Second.' });
    api.getSectionExample = example;
    const props = {
      api,
      docId: 'd',
      label: 'Section 1',
      onOpenSection: () => undefined,
      pollMs: 5,
      coolDownMs: 5,
    };
    const view = render(<SectionExample {...props} brief={brief('sec-1')} />);
    fireEvent.click(screen.getByRole('button', { name: /Show an example/ }));
    await screen.findByText('Nothing here.');
    // Another part of the page: its first failure is retried on its own again.
    view.rerender(<SectionExample {...props} brief={brief('sec-2')} />);
    await screen.findByText('Second.');
    expect(example).toHaveBeenCalledTimes(4);
  });
});
