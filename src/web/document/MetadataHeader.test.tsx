import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DocDetail, DocKind } from '../../core/model/index.js';
import { MetadataHeader } from './MetadataHeader.js';

afterEach(cleanup);

function detailWith(overrides: Partial<DocDetail> = {}): DocDetail {
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
    },
    outline: [
      { id: 'sec-3', num: '3', level: 1 },
      { id: 'sec-4', num: 'Section 4.', level: 1 },
    ],
    externalRefs: [],
    warnings: [],
    hasLineNumbers: true,
    ...overrides,
  };
}

function withMeta(meta: Partial<DocDetail['metadata']>): DocDetail {
  const base = detailWith();
  return { ...base, metadata: { ...base.metadata, ...meta } };
}

describe('doc kind label', () => {
  const cases: [DocKind, string][] = [
    ['charter_amendment', 'Charter amendment · City of Columbus, Ohio'],
    ['resolution', 'Resolution · City of Columbus, Ohio'],
    ['ballot_issue', 'Ballot issue · City of Columbus, Ohio'],
    ['ordinance', 'Ordinance · City of Columbus, Ohio'],
  ];
  test.each(cases)('%s renders "%s"', (docKind, text) => {
    render(<MetadataHeader detail={withMeta({ docKind })} />);
    expect(screen.getByText(text)).toBeTruthy();
    // The kind line carries the jurisdiction, so there is no second row for it.
    expect(screen.queryByText('Jurisdiction')).toBeNull();
  });

  test('without a jurisdiction the label stands alone', () => {
    render(
      <MetadataHeader
        detail={withMeta({ docKind: 'ordinance', jurisdiction: null })}
      />,
    );
    expect(screen.getByText('Ordinance')).toBeTruthy();
  });

  test.each<DocKind | undefined>(['bill', 'other', undefined])(
    '%s keeps the plain bill look',
    (docKind) => {
      render(<MetadataHeader detail={withMeta(docKind ? { docKind } : {})} />);
      expect(document.querySelector('.doc-kind')).toBeNull();
      expect(screen.getByText('Jurisdiction')).toBeTruthy();
    },
  );
});

describe('amends line', () => {
  const amends = {
    name: 'Columbus City Charter',
    sections: ['3', '4', '41-5'],
  };

  test('links sections found in the outline and leaves the rest as text', () => {
    const onOpen = vi.fn();
    render(
      <MetadataHeader
        detail={withMeta({ amends, docKind: 'charter_amendment' })}
        onOpenSection={onOpen}
      />,
    );
    const line = document.querySelector('.doc-amends');
    expect(line?.textContent).toBe(
      'Amends: Columbus City Charter §§ 3, 4, 41-5',
    );
    // "Section 4." in the outline still matches "4".
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Section 4 of the Columbus City Charter',
      }),
    );
    expect(onOpen).toHaveBeenCalledWith('sec-4', expect.any(HTMLElement));
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(
      screen.queryByRole('button', {
        name: 'Section 41-5 of the Columbus City Charter',
      }),
    ).toBeNull();
  });

  test('without an opener every section is plain text', () => {
    render(
      <MetadataHeader
        detail={withMeta({ amends, docKind: 'charter_amendment' })}
      />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/41-5/)).toBeTruthy();
  });

  test('a target with no sections shows just the name', () => {
    render(
      <MetadataHeader
        detail={withMeta({
          amends: { name: 'Revised Code', sections: [] },
          docKind: 'ordinance',
        })}
      />,
    );
    expect(document.querySelector('.doc-amends')?.textContent).toBe(
      'Amends: Revised Code',
    );
  });

  test('one section gets a single section sign', () => {
    render(
      <MetadataHeader
        detail={withMeta({
          amends: { name: 'Columbus City Charter', sections: ['3'] },
          docKind: 'charter_amendment',
        })}
      />,
    );
    expect(document.querySelector('.doc-amends')?.textContent).toBe(
      'Amends: Columbus City Charter § 3',
    );
  });

  test('a number shared by two outline items is not linked', () => {
    const detail = withMeta({ amends, docKind: 'ordinance' });
    detail.outline = [
      { id: 'own-3', num: 'Section 3', level: 1 },
      { id: 'sec-3', num: '3', level: 2 },
      { id: 'sec-4', num: '4', level: 2 },
    ];
    render(<MetadataHeader detail={detail} onOpenSection={vi.fn()} />);
    expect(
      screen.queryByRole('button', {
        name: 'Section 3 of the Columbus City Charter',
      }),
    ).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  test.each<DocKind | undefined>(['bill', 'other', undefined])(
    'a %s that amends a charter shows no amends line',
    (docKind) => {
      render(
        <MetadataHeader
          detail={withMeta({ amends, ...(docKind ? { docKind } : {}) })}
        />,
      );
      expect(document.querySelector('.doc-amends')).toBeNull();
    },
  );

  test('absent amends renders no line', () => {
    render(<MetadataHeader detail={detailWith()} />);
    expect(document.querySelector('.doc-amends')).toBeNull();
  });
});

describe('scan badge', () => {
  const scan = {
    pages: [
      { page: 1, marks: 'read' as const },
      { page: 2, marks: 'not-read' as const },
      { page: 3, marks: 'uncertain' as const },
    ],
  };

  test('lists each page with words, not just color', () => {
    render(<MetadataHeader detail={detailWith({ scan })} />);
    expect(
      screen.getByRole('region', { name: 'Scanned document' }),
    ).toBeTruthy();
    expect(screen.getByText('Page 1: marks read')).toBeTruthy();
    expect(screen.getByText('Page 2: marks not read')).toBeTruthy();
    expect(screen.getByText('Page 3: marks uncertain')).toBeTruthy();
    // Each row carries an icon too.
    expect(document.querySelectorAll('.scan-page svg')).toHaveLength(3);
  });

  test('scan warnings sit under the badge and are not repeated in the notes', () => {
    const scanWarning = 'Page 2 of this scan could not be read.';
    const other = 'Line numbers were not found on page 3.';
    render(
      <MetadataHeader
        detail={detailWith({ scan, warnings: [scanWarning, other] })}
      />,
    );
    const badge = screen.getByRole('region', { name: 'Scanned document' });
    expect(badge.textContent).toContain(scanWarning);
    expect(badge.textContent).not.toContain(other);
    expect(screen.getAllByText(scanWarning)).toHaveLength(1);
    expect(screen.getAllByText(other)).toHaveLength(1);
  });

  test('unrelated warnings that mention scanning stay out of the badge', () => {
    const w = 'Scanning the table of contents found no sections.';
    render(<MetadataHeader detail={detailWith({ scan, warnings: [w] })} />);
    const badge = screen.getByRole('region', { name: 'Scanned document' });
    expect(badge.textContent).not.toContain(w);
    expect(screen.getByText(w)).toBeTruthy();
  });

  test('no badge without scan data, and warnings stay in the general list', () => {
    const warning = 'This scan looks faint.';
    render(<MetadataHeader detail={detailWith({ warnings: [warning] })} />);
    expect(screen.queryByText('Scanned document')).toBeNull();
    expect(screen.getByText(warning)).toBeTruthy();
  });

  test('an empty page list still shows the badge', () => {
    render(<MetadataHeader detail={detailWith({ scan: { pages: [] } })} />);
    expect(screen.getByText('Scanned document')).toBeTruthy();
    expect(document.querySelector('.scan-pages')).toBeNull();
  });
});
