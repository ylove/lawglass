import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DocDetail } from '../../core/model/index.js';
import { MetadataHeader } from './MetadataHeader.js';

afterEach(cleanup);

// Pins AmendsTarget.sectionIds (#325): link only to sections that reprint charter text.
describe('Amends link with sectionIds', () => {
  function detail(sectionIds?: string[]): DocDetail {
    return {
      doc: {
        docId: 'a'.repeat(64),
        label: 'Issue 8',
        sourceUrl: 'https://example.gov/issue8.pdf',
        format: 'pdf',
        title: 'Issue 8',
        billNumber: null,
        ingestedAt: '2026-10-13T12:00:00.000Z',
        lastUsedAt: '2026-10-13T12:00:00.000Z',
        backend: 'local',
      },
      metadata: {
        title: 'Issue 8',
        billNumber: null,
        jurisdiction: 'City of Columbus, Ohio',
        session: null,
        version: null,
        sponsors: null,
        source: 'structured',
        docKind: 'charter_amendment',
        amends: {
          name: 'Columbus City Charter',
          sections: ['3', '4'],
          ...(sectionIds ? { sectionIds } : {}),
        },
      },
      // The measure lists charter section 3 without reprinting it and has its own Section 3;
      // only section 4 is reprinted.
      outline: [
        { id: 'own-3', num: 'Section 3', level: 1 },
        { id: 'sec-4', num: '4', level: 2 },
      ],
      externalRefs: [],
      warnings: [],
      hasLineNumbers: true,
    };
  }
  const link3 = { name: 'Section 3 of the Columbus City Charter' };

  test("a listed but unreprinted number does not open the measure's own section", () => {
    render(
      <MetadataHeader detail={detail(['sec-4'])} onOpenSection={vi.fn()} />,
    );
    expect(screen.queryByRole('button', link3)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  test('a reprinted number links to the reprinted section', () => {
    const onOpen = vi.fn();
    render(
      <MetadataHeader detail={detail(['sec-4'])} onOpenSection={onOpen} />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Section 4 of the Columbus City Charter',
      }),
    );
    expect(onOpen).toHaveBeenCalledWith('sec-4', expect.any(HTMLElement));
  });

  test('without sectionIds (old cached documents) the old matching applies', () => {
    render(<MetadataHeader detail={detail()} onOpenSection={vi.fn()} />);
    expect(screen.getByRole('button', link3)).toBeTruthy();
  });
});
