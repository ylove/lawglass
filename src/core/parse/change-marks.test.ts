import { describe, expect, it } from 'vitest';
import {
  applyChangeMarks,
  changeMarkConvention,
  changeMarkJurisdiction,
} from './change-marks.js';
import {
  NY_LEGEND,
  NJ_LEGEND,
  bracketHtml,
  bracketText,
  bracketPdf,
} from '../../../tests/synth/brackets.js';
import { parseText } from './text.js';
import { parseHtml } from './html.js';
import { parsePdf } from './pdf.js';
import {
  sectionText,
  walkSections,
  type NormalizedDoc,
} from '../model/index.js';

const options = {
  sourceUrl: 'https://legislation.nysenate.gov/bill',
  fetchedAt: '2026-10-25T00:00:00.000Z',
};
const spans = (doc: NormalizedDoc) =>
  [...walkSections(doc.sections)].flatMap((s) => s.spans);
const removed = (doc: NormalizedDoc) =>
  spans(doc)
    .filter((s) => s.status === 'deleted')
    .map((s) => s.text)
    .join('');

describe('legend-gated conventions', () => {
  it('requires the matching jurisdiction AND complete legend', () => {
    expect(changeMarkConvention(NY_LEGEND, options)).toBe('bracket-underline');
    expect(
      changeMarkConvention(NJ_LEGEND, { sourceUrl: 'https://pub.njleg.gov/a' }),
    ).toBe('bracket-underline');
    expect(
      changeMarkConvention(NY_LEGEND, {
        sourceUrl: 'https://example.gov',
        jurisdiction: 'New York',
      }),
    ).toBe('bracket-underline');
    for (const [text, sourceUrl] of [
      [NY_LEGEND, 'https://example.gov'],
      [NJ_LEGEND, options.sourceUrl],
      ['Matter in brackets is omitted.', options.sourceUrl],
    ])
      expect(changeMarkConvention(text!, { sourceUrl: sourceUrl! })).toBe(
        'default',
      );
    expect(
      changeMarkJurisdiction({
        sourceUrl: 'https://example.gov',
        jurisdiction: 'New Jersey',
      }),
    ).toBe('NJ');
  });
  it('warns and treats an unclosed deletion conservatively', () => {
    const result = applyChangeMarks(
      [{ text: `${NY_LEGEND}\nSection 1. [old` }],
      options,
    );
    expect(result.lines[0]?.statuses?.at(-1)).toBe('deleted');
    expect(result.warnings[0]).toMatch(/not closed/);
    expect(
      applyChangeMarks([{ text: `${NY_LEGEND}\n]` }], options).warnings[0],
    ).toMatch(/unmatched closing/);
  });
  it('handles numbered NJ committee brackets and removes the legend example', () => {
    const doc = parseText(
      `${NJ_LEGEND}\nSection 1. 1[old, punctuation]1 and ²[obsolete]² new.`,
      { ...options, sourceUrl: 'https://pub.njleg.state.nj.us/bill.txt' },
    );
    expect(removed(doc)).toContain('1[old, punctuation]1');
    expect(removed(doc)).toContain('²[obsolete]²');
    expect(removed(doc)).not.toContain('thus');
  });
  it('keeps bracket lookalikes on unrecognized hosts and without a legend', () => {
    for (const doc of [
      parseText('Section 1. [old]', options),
      parseHtml('<pre>Section 1. [old] <i>emphasis</i></pre>', options),
      parseText(bracketText(), {
        ...options,
        sourceUrl: 'https://ohio.gov/bill',
      }),
    ])
      expect(removed(doc)).toBe('');
  });
});

for (const format of ['text', 'html', 'pdf'] as const) {
  it(`${format}: brackets cross lines/elements/pages, deleted headings cannot leak, literals stay current`, async () => {
    const doc =
      format === 'text'
        ? parseText(bracketText(), options)
        : format === 'html'
          ? parseHtml(bracketHtml(), options)
          : await parsePdf(await bracketPdf(), options);
    const deleted = removed(doc);
    expect(deleted).toContain('old');
    expect(deleted).toContain('Section 99. Repealed heading');
    expect(deleted).not.toMatch(/Reserved|sic|U\.S\.C\.|N\.Y\.|EXPLANATION/);
    const sections = [...walkSections(doc.sections)];
    expect(sections.map((s) => s.id)).not.toContain('sec-99');
    expect(sections.some((s) => s.id === 'sec-1/1/a/i')).toBe(true);
    const current = sections
      .map((s) => sectionText(s, { includeDeleted: false }))
      .join('');
    expect(current).not.toContain('Repealed heading');
    expect(current).toContain('[Reserved]');
    if (format !== 'text') {
      const inserted = spans(doc)
        .filter((s) => s.status === 'inserted')
        .map((s) => s.text)
        .join('');
      expect(inserted).toContain(
        format === 'html' ? 'replaced' : 'italic addition',
      );
      expect(inserted).toContain('underlined');
    }
    if (format === 'pdf')
      expect(
        spans(doc)
          .filter((s) => s.status === 'deleted')
          .map((s) => s.page),
      ).toContain(2);
    else expect(deleted).toContain('[3]');
  });
}
it('PDF italics stay unchanged without the legend; existing underline behavior stays active', async () => {
  const doc = await parsePdf(await bracketPdf(false), options);
  expect(removed(doc)).toBe('');
  expect(
    spans(doc).find((s) => s.text.includes('italic addition'))?.status,
  ).toBe('unchanged');
});
it('HTML italic inline/class styles apply only under the verified convention', () => {
  const doc = parseHtml(
    `<style>.added {font-style:italic}</style><p>${NY_LEGEND}</p><p>Section 1. <span class="added">added</span> <span style="font-style:oblique">slanted</span> <del><i>gone</i></del></p>`,
    options,
  );
  expect(
    spans(doc)
      .filter((s) => s.status === 'inserted')
      .map((s) => s.text)
      .join(''),
  ).toContain('added');
  expect(removed(doc)).toContain('gone');
});

it('NJ HTML honors bold brackets and raised committee numbers; its italic enacting style is unchanged', () => {
  const html = bracketHtml(NJ_LEGEND)
    .replace('STATE OF NEW YORK', 'STATE OF NEW JERSEY')
    .replace('[<b>old</b>', '<sup>1</sup>[<b>old</b>')
    .replace('page</span>]', 'page</span>]<sup>1</sup>');
  const doc = parseHtml(
    `<p>Matter enclosed in superscript numerals has been adopted as follows:</p>${html}`,
    { ...options, sourceUrl: 'https://pub.njleg.gov/bill.htm' },
  );
  expect(removed(doc)).toContain('old');
  expect(
    spans(doc).some(
      (s) => s.status === 'inserted' && s.text.includes('underlined'),
    ),
  ).toBe(true);
  expect(
    spans(doc).some(
      (s) => s.status === 'inserted' && s.text.includes('replaced'),
    ),
  ).toBe(false);
  expect(
    spans(doc)
      .map((s) => s.text)
      .join(''),
  ).not.toMatch(/1\[|\]1/);
});
it('NJ PDF bracket and underline semantics work across pages and remove raised committee numbers', async () => {
  const doc = await parsePdf(await bracketPdf('NJ'), {
    ...options,
    sourceUrl: 'https://pub.njleg.gov/bill.pdf',
  });
  expect(removed(doc)).toContain('old wording');
  expect(removed(doc)).toContain('continues here]');
  expect(removed(doc)).not.toMatch(/Reserved|sic|thus/);
  const inserted = spans(doc)
    .filter((s) => s.status === 'inserted')
    .map((s) => s.text)
    .join('');
  expect(inserted).toContain('underlined addition');
  expect(inserted).not.toContain('italic addition');
  expect(spans(doc).filter((s) => s.text.trim() === '1')).toEqual([]);
});
it('italic insertion is independent of text-decoration:none and strike still wins', () => {
  const doc = parseHtml(
    `<p>${NY_LEGEND}</p><p>Section 1. <span style="font-style:italic;text-decoration:none">new</span> <span style="text-decoration:line-through;font-style:italic">old</span></p>`,
    options,
  );
  expect(spans(doc).find((s) => s.text === 'new')?.status).toBe('inserted');
  expect(removed(doc)).toContain('old');
});

it('PDF layout may remove the legend footer after it was verified in extracted text', () => {
  const result = applyChangeMarks(
    [{ text: 'Section 1. [old] new.', page: 2, line: 1, x: 72 }],
    options,
    NY_LEGEND,
  );
  expect(result.convention).toBe('bracket-underline');
  expect(result.lines[0]?.statuses?.[11]).toBe('deleted');
  expect(result.lines[0]).toMatchObject({ page: 2, line: 1, x: 72 });
});

it('a bracketed whole section or repealed citation clause is not mistaken for a literal citation', () => {
  const doc = parseText(
    `${NY_LEGEND}\nSection 1. Scope.\n[Section 99. Repealed text.]\n[42 U.S.C. 1983 is repealed]\nSection 2. See [section 3(a)] and [123 N.Y.2d 456].`,
    options,
  );
  expect(removed(doc)).toContain('[Section 99. Repealed text.]');
  expect(removed(doc)).toContain('[42 U.S.C. 1983 is repealed]');
  expect(removed(doc)).not.toMatch(/section 3\(a\)|123 N\.Y/);
  expect([...walkSections(doc.sections)].map((s) => s.id)).not.toContain(
    'sec-99',
  );
});

it('a legend hidden in page noise cannot activate italic or bracket amendments', () => {
  const doc = parseHtml(
    `<aside>${NY_LEGEND}</aside><p>Section 1. [current] <i>emphasis</i>.</p>`,
    options,
  );
  expect(removed(doc)).toBe('');
  expect(spans(doc).some((s) => s.status === 'inserted')).toBe(false);
});
