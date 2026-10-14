import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { makeAmendingBillPdf } from '../../tests/synth/pdf.js';
import {
  makeCongressionalBillXml,
  makeUslmXml,
} from '../../tests/synth/xml.js';
import {
  EMPTY_METADATA,
  type NormalizedDoc,
  type Section,
} from './model/index.js';
import { parseText } from './parse/text.js';
import { parsePdf } from './parse/pdf.js';
import { parseHtml } from './parse/html.js';
import { parseXml } from './parse/xml.js';
import { detectSections } from './parse/sections.js';
import { documentPreview, PREVIEW_MAX_LENGTH } from './preview.js';

const options = {
  sourceUrl: 'https://example.gov/bill',
  fetchedAt: '2026-10-14T00:00:00.000Z',
};
function doc(
  sections: Section[] = [],
  title: string | null = null,
): NormalizedDoc {
  return {
    docId: 'a'.repeat(64),
    ...options,
    format: 'text',
    sections,
    metadata: { ...EMPTY_METADATA, title },
    definitions: [],
    externalRefs: [],
    warnings: [],
  };
}
const front = (text: string): Section => ({
  id: 'preamble',
  level: 1,
  spans: [{ text, status: 'unchanged' }],
  children: [],
});

describe('documentPreview', () => {
  it('extracts a federal A BILL purpose from plain-text front matter, with its section id', () => {
    const parsed = parseText(
      '119th CONGRESS\nA BILL\nTo establish seed libraries.\nBe it enacted by the Senate and House:\nSection 1. Grants\nTowns may apply.',
      options,
    );
    expect(documentPreview(parsed)).toEqual({
      kind: 'purpose',
      text: 'To establish seed libraries.',
      sectionId: 'preamble',
    });
  });

  it('uses the congressional XML metadata title when form text is absent from sections', () => {
    const parsed = parseXml(makeCongressionalBillXml().bytes, options);
    expect(documentPreview(parsed)).toEqual({
      kind: 'title',
      text: 'Synthetic garden grants act',
    });
    const xml =
      '<bill><form><legis-type>A BILL</legis-type><official-title>To amend the seed law to fund gardens.</official-title></form><legis-body><section><enum>1.</enum><text>Towns may apply.</text></section></legis-body></bill>';
    expect(documentPreview(parseXml(xml, options))).toEqual({
      kind: 'purpose',
      text: 'To amend the seed law to fund gardens.',
    });
  });

  it('finds a purpose in synthetic XML-like front matter before a short metadata title', () => {
    const parsed = doc(
      [front('A BILL\nTo amend the seed law to fund gardens.')],
      'Garden Act',
    );
    parsed.format = 'xml';
    const before = structuredClone(parsed);
    expect(documentPreview(parsed)).toEqual({
      kind: 'purpose',
      text: 'To amend the seed law to fund gardens.',
      sectionId: 'preamble',
    });
    expect(parsed).toEqual(before);
  });

  it('reads Ohio PDF-style numbered source lines, decimal code references and wrapped purpose text', () => {
    const sections = detectSections(
      [
        'As Introduced',
        'H. B. No. 9001',
        'A BILL',
        'To amend sections 5747.01 and 5747.02 of the Revised',
        'Code to establish a community garden credit.',
        'BE IT ENACTED BY THE GENERAL ASSEMBLY OF THE STATE OF OHIO:',
        'Section 1. That sections 5747.01 and 5747.02 be amended.',
      ].map((text, i) => ({ text, page: 1, line: i + 1 })),
    );
    const parsed = { ...doc(sections), format: 'pdf' as const };
    expect(documentPreview(parsed)).toEqual({
      kind: 'purpose',
      text: 'To amend sections 5747.01 and 5747.02 of the Revised Code to establish a community garden credit.',
      sectionId: 'preamble',
    });
  });

  it('preserves an Ohio purpose wrapped before a lowercase section reference', () => {
    const text =
      'To amend sections 2929.28 and 5122.311 and to enact\n' +
      'section 2923.27 of the Revised Code to regulate\n' +
      'the transfer of firearms at a gun show.\n' +
      'BE IT ENACTED BY THE GENERAL ASSEMBLY OF THE STATE OF OHIO:\n' +
      'Section 1. That section 2923.27 be enacted.';
    expect(documentPreview(doc([front(text)]))).toEqual({
      kind: 'purpose',
      text: 'To amend sections 2929.28 and 5122.311 and to enact section 2923.27 of the Revised Code to regulate the transfer of firearms at a gun show.',
      sectionId: 'preamble',
    });
  });

  it.each(['section 1.', 'Section 1', 'Section 2923.27'])(
    'keeps a wrapped reference rather than treating %s as an operative section',
    (reference) => {
      expect(
        documentPreview(
          doc([
            front(
              `To amend\n${reference} of the code.\nBe it enacted by the legislature.`,
            ),
          ]),
        )?.text,
      ).toBe(`To amend ${reference} of the code.`);
    },
  );

  it.each([
    '_______\nIN THE SENATE OF THE UNITED STATES',
    'IN THE SENATE OF THE UNITED STATES',
    'IN THE HOUSE OF REPRESENTATIVES',
    '121st CONGRESS',
    '122nd CONGRESS',
    '123rd CONGRESS',
    '119th CONGRESS',
  ])('ends a GovInfo HTML purpose before federal boilerplate: %s', (tail) => {
    const parsed = parseHtml(
      `<pre>A BILL\nTo require garden grants and for other purposes.\n${tail}\nJanuary 23, 2025\nA senator introduced the following bill.</pre>`,
      options,
    );
    expect(documentPreview(parsed)).toEqual({
      kind: 'purpose',
      text: 'To require garden grants and for other purposes.',
      sectionId: 'preamble',
    });
  });

  it('extracts a purpose from a parsed synthetic Ohio PDF', async () => {
    const sample = await makeAmendingBillPdf({ pageCount: 2 });
    const pdf = await PDFDocument.load(sample.bytes);
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf
      .getPages()[0]!
      .drawText('To amend section 5747.01 to fund garden credits.', {
        x: 72,
        y: 670,
        size: 11,
        font,
      });
    const parsed = await parsePdf(await pdf.save(), options);
    expect(documentPreview(parsed)).toEqual({
      kind: 'purpose',
      text: 'To amend section 5747.01 to fund garden credits.',
      sectionId: 'preamble',
    });
  });

  it('never includes deleted text and keeps inserted text without splitting adjacent runs', () => {
    const section = front('');
    section.spans = [
      { text: 'To amend ', status: 'unchanged' },
      { text: 'the obsolete credit ', status: 'deleted' },
      { text: 'the garden', status: 'inserted' },
      { text: 's credit.', status: 'unchanged' },
    ];
    section.heading = 'To amend the obsolete credit';
    expect(documentPreview(doc([section]))).toEqual({
      kind: 'purpose',
      text: 'To amend the gardens credit.',
      sectionId: 'preamble',
    });
    section.spans = [
      { text: 'To repeal the garden credit.', status: 'deleted' },
    ];
    expect(documentPreview(doc([section]))).toBeUndefined();
  });

  it('uses a title section id and removes struck title text even when copied into metadata', () => {
    const section = front('Garden Act');
    expect(documentPreview(doc([section], 'Garden Act'))).toEqual({
      kind: 'title',
      text: 'Garden Act',
      sectionId: 'preamble',
    });
    section.spans = [
      { text: 'Old ', status: 'deleted' },
      { text: 'Garden Act', status: 'inserted' },
    ];
    expect(documentPreview(doc([section], 'Old Garden Act'))).toEqual({
      kind: 'title',
      text: 'Garden Act',
      sectionId: 'preamble',
    });
    section.spans = [{ text: 'Old Garden Act', status: 'deleted' }];
    expect(documentPreview(doc([section], 'Old Garden Act'))).toBeUndefined();
  });

  it('does not revive a struck purpose or title copied into metadata from inside a preamble', () => {
    const section = front('');
    section.spans = [
      { text: 'A BILL\n', status: 'unchanged' },
      { text: 'To repeal the garden credit.', status: 'deleted' },
    ];
    expect(
      documentPreview(doc([section], 'To repeal the garden credit.')),
    ).toBeUndefined();
    section.spans[1] = { text: 'Old Garden Act', status: 'deleted' };
    expect(documentPreview(doc([section], 'Old Garden Act'))).toBeUndefined();
  });

  it('falls back to an official title without treating an operative To clause as the purpose', () => {
    const section = {
      ...front('To apply for a grant, file a form.'),
      id: 'sec-1',
      num: '1',
    };
    expect(documentPreview(doc([section], 'Seed Library Act'))).toEqual({
      kind: 'title',
      text: 'Seed Library Act',
    });
    expect(documentPreview(parseXml(makeUslmXml().bytes, options))).toEqual({
      kind: 'title',
      text: 'Synthetic Seed Library Amendment',
    });
    expect(documentPreview(doc([], ' A BILL\nTo establish gardens. '))).toEqual(
      { kind: 'purpose', text: 'To establish gardens.' },
    );
  });

  it('does not invent a title from arbitrary preamble or empty metadata', () => {
    for (const title of [null, '', '   '])
      expect(
        documentPreview(doc([front('H. B. 1\nAs Introduced')], title)),
      ).toBeUndefined();
  });

  it('caps purpose and title at a word boundary, with an ellipsis', () => {
    for (const parsed of [
      doc([front(`To amend ${'the garden program '.repeat(50)}`)]),
      doc([], 'Garden '.repeat(100)),
      doc([], 'x'.repeat(600)),
    ]) {
      const preview = documentPreview(parsed)!;
      expect(preview.text.length).toBeLessThanOrEqual(PREVIEW_MAX_LENGTH);
      expect(preview.text).toMatch(/…$/);
    }
    expect(
      documentPreview(doc([], 'x'.repeat(PREVIEW_MAX_LENGTH)))?.text.length,
    ).toBe(PREVIEW_MAX_LENGTH);
  });

  it('bounds the scan to early sections, characters and pages', () => {
    const late = front('To amend late provisions.');
    expect(
      documentPreview(doc([front('x'.repeat(8000)), late])),
    ).toBeUndefined();
    expect(
      documentPreview(
        doc(
          Array.from({ length: 9 }, (_, i) =>
            i === 8 ? late : front('Header'),
          ),
        ),
      ),
    ).toBeUndefined();
    expect(documentPreview(doc([{ ...late, pageStart: 4 }]))).toBeUndefined();
  });

  it('walks nested front matter and stops before body text in a whole-document section', () => {
    expect(
      documentPreview(
        doc([{ ...front(''), children: [front('To fund gardens.')] }]),
      )?.kind,
    ).toBe('purpose');
    expect(
      documentPreview(
        doc([
          front('A BILL To fund gardens.\nSection 1. Grants\nTowns may apply.'),
        ]),
      )?.text,
    ).toBe('To fund gardens.');
    expect(documentPreview(doc([front('To x')]))?.text).toBe('To x');
  });
});

describe('documentPreview for charter amendments', () => {
  const run = (text: string) => documentPreview(parseText(text, options))?.text;

  it('uses a leading "To amend the City Charter" ballot question', () => {
    expect(
      run(
        'To amend the City Charter to create an independent redistricting commission.\nSec. 3. - Powers.\nThe council shall act.',
      ),
    ).toBe(
      'To amend the City Charter to create an independent redistricting commission.',
    );
  });

  it('uses a "Shall the Charter ... be amended" question and stops at its question mark', () => {
    expect(
      run(
        'Shall the Charter of the City of Columbus be amended to add Section 46-3?\nExplanation follows here.\nSec. 46-3 - Recall.\nText.',
      ),
    ).toBe(
      'Shall the Charter of the City of Columbus be amended to add Section 46-3?',
    );
  });

  it('stops before a dash-style section heading', () => {
    expect(run('To amend the Charter.\nSec. 3.- Powers.\nBody.')).toBe(
      'To amend the Charter.',
    );
  });

  it('does not treat other "Shall" sentences as ballot questions', () => {
    expect(run('Shall the board meet monthly?\nSec. 1. Meetings.\nX.')).toBe(
      undefined,
    );
  });
});
