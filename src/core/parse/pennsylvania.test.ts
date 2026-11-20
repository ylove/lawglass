import { expect, test } from 'vitest';
import { paAmendingText, paPdf } from '../../../tests/synth/pennsylvania.js';
import {
  sectionText,
  walkSections,
  type NormalizedDoc,
  type Span,
} from '../model/index.js';
import {
  applyChangeMarks,
  changeMarkConvention,
  isLegendNotFoundWarning,
  pennsylvaniaAmendingBill,
} from './change-marks.js';
import { parsePdf } from './pdf.js';
import { parseText } from './text.js';
import {
  pennsylvaniaMetadata,
  pennsylvaniaSessionLabel,
} from './pennsylvania.js';

// Built with URL so the host is never a bare string literal that reads like a pattern.
const paUrl = (path = '/legislation/bills/text/PDF/2025/0/HB9001/PN9001') =>
  new URL(path, 'https://www.palegis.us').href;
const context = { sourceUrl: paUrl(), fetchedAt: '2026-11-19T00:00:00.000Z' };
const mirror = {
  sourceUrl: new URL('/bill', 'https://example.gov').href,
  fetchedAt: context.fetchedAt,
};

const spans = (doc: NormalizedDoc): Span[] =>
  [...walkSections(doc.sections)].flatMap((section) => section.spans);
const runs = (doc: NormalizedDoc, status: Span['status']): string[] => {
  const found: string[] = [];
  let current = '';
  for (const span of spans(doc)) {
    if (span.status === status) current += span.text;
    else if (span.text.trim() && current) {
      found.push(current.replace(/\s+/g, ' ').trim());
      current = '';
    }
  }
  if (current) found.push(current.replace(/\s+/g, ' ').trim());
  return found;
};
const allText = (doc: NormalizedDoc): string =>
  [...walkSections(doc.sections)]
    .map((section) => sectionText(section, { includeDeleted: true }))
    .join('\n');

test('an amending bill: bracketed old law is deleted, underlined new law is inserted', async () => {
  const doc = await parsePdf(await paPdf('amending'), context);
  expect(runs(doc, 'deleted')).toEqual(['[for ten years]']);
  expect(runs(doc, 'inserted')).toEqual(['for twelve years']);
  // The printer's number on the cover is underlined on paper but is not an insertion.
  expect(allText(doc)).toContain("PRINTER'S NO. 9001");
  expect(doc.warnings).not.toContainEqual(
    expect.stringMatching(/bracket|legend/i),
  );
  expect(doc.metadata).toMatchObject({
    title:
      'Amending Title 75 (Vehicles) of the Pennsylvania Consolidated Statutes, further providing for sample permits.',
    billNumber: 'HB 9001',
    jurisdiction: 'Pennsylvania',
    session: '2025-2026 Regular Session',
    version: "Printer's No. 9001",
    sponsors: ['EXAMPLE'],
    docKind: 'bill',
    source: 'structured',
  });
});

test('an amended new act: strike-out is deleted, capitals are inserted, pointers and a literal bracket are left alone', async () => {
  const doc = await parsePdf(await paPdf('amended-new-act'), context);
  expect(runs(doc, 'deleted')).toEqual(['in every case']);
  expect(runs(doc, 'inserted')).toEqual(['ON EACH COVERED OFFENSE']);
  // "[sic]" is ordinary text in an act that amends nothing, and "<--" is the legislature's pointer.
  expect(allText(doc)).toContain('Sample Fee Act. [sic]');
  expect(allText(doc)).not.toContain('<--');
  // The cover's printer's numbers stay unchanged text.
  expect(runs(doc, 'inserted')).not.toContainEqual(
    expect.stringMatching(/PRINTER/),
  );
  expect(doc.metadata.title).toBe('Providing for a sample fee.');
  expect(doc.metadata.version).toBe("Printer's No. 9001");
});

test('a resolution keeps its brackets and is a resolution', async () => {
  const doc = await parsePdf(await paPdf('resolution'), context);
  expect(runs(doc, 'deleted')).toEqual([]);
  expect(runs(doc, 'inserted')).toEqual([]);
  expect(allText(doc)).toContain('[by the Commonwealth]');
  expect(doc.metadata).toMatchObject({
    billNumber: 'HR 77',
    docKind: 'resolution',
    title:
      'Designating the week of May 4, 2026, as "Sample Week" in Pennsylvania.',
  });
});

test('the text parser applies the same rule to a palegis.us source', () => {
  const doc = parseText(Buffer.from(paAmendingText()), context);
  expect(runs(doc, 'deleted')).toEqual(['[for ten years]']);
  expect(doc.metadata.billNumber).toBe('HB 9001');
  // Cover words before the title are never marked.
  expect(
    spans(doc)
      .filter((s) => s.status !== 'unchanged')
      .map((s) => s.text),
  ).toEqual(['[for ten years]']);
});

test('brackets are ordinary text on a host that is not a PA source', () => {
  expect(
    changeMarkConvention(paAmendingText(), {
      sourceUrl: mirror.sourceUrl,
    }),
  ).toBe('default');
  const doc = parseText(Buffer.from(paAmendingText()), mirror);
  expect(runs(doc, 'deleted')).toEqual([]);
  // A mirror is still recognised as a Pennsylvania bill by its cover, as for New Jersey.
  expect(doc.metadata.jurisdiction).toBe('Pennsylvania');
});

test('the gate needs the printed cover and an amending bill', () => {
  expect(pennsylvaniaAmendingBill(paAmendingText())).toBe(true);
  // A cover that amends nothing keeps its brackets.
  expect(
    pennsylvaniaAmendingBill(
      'THE GENERAL ASSEMBLY OF PENNSYLVANIA\nAN ACT\nProviding for samples.\nSection 1. A [sic] note.',
    ),
  ).toBe(false);
  // "amended" in a bill that is not on the cover page of a Pennsylvania document.
  expect(
    pennsylvaniaAmendingBill('Section 1. The act is amended to read:'),
  ).toBe(false);
  // A joint resolution amends the Constitution.
  expect(
    pennsylvaniaAmendingBill(
      'THE GENERAL ASSEMBLY OF PENNSYLVANIA\nA JOINT RESOLUTION\nThat Article III be amended by adding a section',
    ),
  ).toBe(true);
});

test('a Pennsylvania text with brackets and no cover warns that nothing was verified', () => {
  const lines = [{ text: 'Section 1. The [old] words.' }];
  const result = applyChangeMarks(lines, context);
  expect(result.convention).toBe('default');
  expect(result.warnings.every(isLegendNotFoundWarning)).toBe(true);
  expect(result.warnings).toHaveLength(1);
  // A cover that amends nothing is not worth a warning.
  const act = applyChangeMarks(
    [
      { text: 'THE GENERAL ASSEMBLY OF PENNSYLVANIA' },
      { text: 'AN ACT' },
      { text: 'Providing for a [sic] sample.' },
    ],
    context,
  );
  expect(act.warnings).toEqual([]);
});

test('unbalanced brackets are recovered at the next boundary, as for other states', () => {
  const doc = parseText(
    Buffer.from(
      [
        'THE GENERAL ASSEMBLY OF PENNSYLVANIA',
        'AN ACT',
        'Amending Title 1 of the Pennsylvania Consolidated Statutes.',
        'Section 1. Section 2 of Title 1 is amended to read:',
        'A rule [that was removed',
        '',
        'Section 2. This act shall take effect immediately.',
      ].join('\n'),
    ),
    context,
  );
  expect(runs(doc, 'deleted')).toEqual(['[that was removed']);
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});

test('metadata is empty without the bill designation or for a mirror without an amending bill', () => {
  const metadata = (text: string, source = context) =>
    pennsylvaniaMetadata(text, source);
  expect(metadata('Pennsylvania is a state.').source).toBe('none');
  expect(
    metadata(
      'THE GENERAL ASSEMBLY OF PENNSYLVANIA\nHOUSE BILL\nNo. 5 2026\nAN ACT\nProviding for samples.',
      mirror,
    ).source,
  ).toBe('none');
  // A Senate bill, a joint resolution numbered as a bill, and a special session.
  const joint = pennsylvaniaMetadata(
    [
      "PRINTER'S NO. 613",
      'THE GENERAL ASSEMBLY OF PENNSYLVANIA',
      'SENATE BILL',
      'Session of',
      'No. 605 2025',
      'INTRODUCED BY DUSH, PHILLIPS-HILL, BAKER AND J. WARD,',
      'APRIL 9, 2025',
      'A JOINT RESOLUTION',
      'Proposing an amendment to the Constitution.',
      'The General Assembly of the Commonwealth of Pennsylvania',
    ].join('\n'),
    {
      ...context,
      sourceUrl: paUrl('/legislation/bills/text/PDF/2023/1/SB0605/PN0613'),
    },
  );
  expect(joint).toMatchObject({
    billNumber: 'SB 605',
    docKind: 'resolution',
    sponsors: ['DUSH'],
    session: '2023-2024 Special Session #1',
    version: "Printer's No. 613",
  });
  expect(pennsylvaniaSessionLabel(2025, 0)).toBe('2025-2026 Regular Session');
});
