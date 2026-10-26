import { expect, it, test } from 'vitest';
import {
  bracketHtml,
  bracketPdf,
  bracketText,
  NY_LEGEND,
  NJ_LEGEND,
} from './brackets.js';

// These regressions use generated legislation only: CI has no downloaded fixtures.
import { parseText } from '../../src/core/parse/text.js';
import { parseHtml } from '../../src/core/parse/html.js';
import { parsePdf } from '../../src/core/parse/pdf.js';
import { sectionText, walkSections } from '../../src/core/model/index.js';

it('generates text and HTML from the same invented bill under either legend', () => {
  expect(bracketText()).toContain('S. 4321--A');
  expect(bracketHtml(NJ_LEGEND)).toContain(NJ_LEGEND);
});
it('generates deterministic PDF bytes for each convention', async () => {
  for (const convention of [true, false, 'NJ'] as const) {
    const first = await bracketPdf(convention);
    expect(first).toEqual(await bracketPdf(convention));
    expect(Buffer.from(first).subarray(0, 5).toString()).toBe('%PDF-');
  }
});

const context = {
  sourceUrl: 'https://legislation.nysenate.gov/bill',
  fetchedAt: '2026-10-25T00:00:00.000Z',
};
for (const [state, legend, sourceUrl] of [
  ['NY', NY_LEGEND, context.sourceUrl],
  ['NJ', NJ_LEGEND, 'https://pub.njleg.gov/bill'],
] as const) {
  test.each(['text', 'html'] as const)(
    `%s: a verified ${state} legend deletes replaced cross-references`,
    (format) => {
      const text = `${legend}\nSection 1. Pursuant to [section 12] section 14 and [42 U.S.C. 1395] 42 U.S.C. 1396. See [3] and [123 N.Y.2d 456] and [§ 12].`;
      const doc =
        format === 'text'
          ? parseText(text, { ...context, sourceUrl })
          : parseHtml(`<pre>${text}</pre>`, { ...context, sourceUrl });
      const sections = [...walkSections(doc.sections)];
      const deleted = sections
        .flatMap((s) => s.spans)
        .filter((s) => s.status === 'deleted')
        .map((s) => s.text)
        .join('');
      for (const old of [
        '[section 12]',
        '[42 U.S.C. 1395]',
        '[3]',
        '[123 N.Y.2d 456]',
        '[§ 12]',
      ])
        expect(deleted).toContain(old);
      const current = sections
        .map((s) => sectionText(s, { includeDeleted: false }))
        .join('');
      expect(current).not.toMatch(/section 12|1395|N\.Y\.|§ 12/);
      expect(current).toContain('section 14');
      expect(current).toContain('42 U.S.C. 1396');
    },
  );
}

test.each(['text', 'html', 'pdf'] as const)(
  '%s: a NY bill without its legend warns while preserving printed brackets',
  async (format) => {
    const text = 'Section 1. Keep [old law] new.';
    const doc =
      format === 'text'
        ? parseText(text, context)
        : format === 'html'
          ? parseHtml(`<pre>${text}</pre>`, context)
          : await parsePdf(await bracketPdf(false), context);
    expect(doc.warnings.join(' ')).toMatch(/New York.*legend.*not found/);
    const spans = [...walkSections(doc.sections)].flatMap((s) => s.spans);
    expect(spans.filter((s) => s.status === 'deleted')).toEqual([]);
    expect(spans.map((s) => s.text).join('')).toContain(
      format === 'pdf' ? '[old wording' : '[old law]',
    );
  },
);

test('NY PDF cover boilerplate is unchanged and does not trigger a border-rule warning', async () => {
  const doc = await parsePdf(await bracketPdf(), context);
  const spans = [...walkSections(doc.sections)].flatMap((s) => s.spans);
  const boilerplate = spans.filter((s) =>
    /The People|represented in Senate/.test(s.text),
  );
  expect(boilerplate.length).toBeGreaterThan(0);
  expect(boilerplate.every((s) => s.status === 'unchanged')).toBe(true);
  expect(doc.warnings.join(' ')).not.toContain('one rule marks the whole line');
  expect(
    spans
      .filter((s) => s.status === 'inserted')
      .map((s) => s.text)
      .join(''),
  ).toContain('underlined addition');
});

test.each([true, 'NJ'] as const)(
  'PDF: convention %s deletes replaced section and statute references',
  async (legend) => {
    const doc = await parsePdf(await bracketPdf(legend), {
      ...context,
      sourceUrl:
        legend === 'NJ' ? 'https://pub.njleg.gov/bill.pdf' : context.sourceUrl,
    });
    const sections = [...walkSections(doc.sections)];
    const removed = sections
      .flatMap((s) => s.spans)
      .filter((s) => s.status === 'deleted')
      .map((s) => s.text)
      .join('');
    expect(removed).toContain('[section 12]');
    expect(removed).toContain('[42 U.S.C. 1983]');
    const current = sections
      .map((s) => sectionText(s, { includeDeleted: false }))
      .join('');
    expect(current).not.toMatch(/section 12|1983/);
    expect(current).toContain('section 14');
  },
);
