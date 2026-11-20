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

const COVER = 'THE GENERAL ASSEMBLY OF PENNSYLVANIA';
const ENACT =
  'The General Assembly of the Commonwealth of Pennsylvania\nhereby enacts as follows:';
const act = (title: string, ...body: string[]) =>
  [COVER, 'AN ACT', ...title.split('\n'), ENACT, ...body].join('\n');
const read = (text: string) => parseText(Buffer.from(text), context);

test('the gate is the title: amending, reenacting, repealing or a constitutional amendment', () => {
  expect(pennsylvaniaAmendingBill(paAmendingText())).toBe(true);
  // Upper case, wrapped title lines and printed line-number gutters.
  expect(
    pennsylvaniaAmendingBill(
      `${COVER}\nAN ACT\n1 REENACTING AND\n2 AMENDING the act.\n${ENACT}`,
    ),
  ).toBe(true);
  expect(pennsylvaniaAmendingBill(act('Repealing section 5 of the act.'))).toBe(
    true,
  );
  expect(
    pennsylvaniaAmendingBill(
      `${COVER}\nA JOINT RESOLUTION\nProposing an amendment to the Constitution.\nThe General Assembly of the Commonwealth of Pennsylvania\nhereby resolves as follows:`,
    ),
  ).toBe(true);
  expect(
    pennsylvaniaAmendingBill(
      `${COVER}\nA JOINT RESOLUTION\nProposing integrated amendments to the\nConstitution of the Commonwealth of Pennsylvania.\nThe General Assembly of the Commonwealth of Pennsylvania\nhereby resolves as follows:`,
    ),
  ).toBe(true);
  // New acts, simple and concurrent resolutions, and "amended" in the body never qualify.
  expect(
    pennsylvaniaAmendingBill(
      act('Providing for samples.', 'Section 1. Bylaws may be amended.'),
    ),
  ).toBe(false);
  for (const kind of ['A RESOLUTION', 'A CONCURRENT RESOLUTION'])
    expect(
      pennsylvaniaAmendingBill(
        `${COVER}\n${kind}\nDesignating a week.\nWHEREAS, x; therefore be it`,
      ),
    ).toBe(false);
  expect(pennsylvaniaAmendingBill('AN ACT\nAmending Title 1.\n' + ENACT)).toBe(
    false,
  );
});

test('every bracket outside an underlined run is deleted in an amending measure, anywhere in the body', () => {
  const doc = read(
    act(
      'Amending the act of June 1, 2001 (P.L.1, No.2), known as the Sample Act.',
      'Section 1. Section 3 of the act is amended to read:',
      'Section 2. Quoted heading.--',
      'A person [shall pay a fee] may pay.',
      'Section 3. This act takes effect [in 60 days] immediately.',
    ),
  );
  expect(runs(doc, 'deleted')).toEqual(['[shall pay a fee]', '[in 60 days]']);
});

test('trade-off: a literal bracket in a plain new section of an amending bill is read as deleted', () => {
  const doc = read(
    act(
      'Amending Title 75.',
      'Section 1. Section 5 of Title 75 is amended to read:',
      'Old [removed] law.',
      'Section 2. The survey form shall read "Name [optional]".',
    ),
  );
  expect(runs(doc, 'deleted')).toEqual(['[removed]', '[optional]']);
});

test('a new act and every kind of resolution keep their brackets', () => {
  const newAct = read(
    act(
      'Providing for samples.',
      'Section 1. Section 4 is amended [as recorded].',
    ),
  );
  expect(runs(newAct, 'deleted')).toEqual([]);
  const resolution = read(
    [
      COVER,
      'A RESOLUTION',
      'Recommending that Article III be amended.',
      'WHEREAS, It was recommended that Article III be amended to read [as recorded]; and',
      'RESOLVED, That Section 1 is amended to read [thus].',
    ].join('\n'),
  );
  expect(runs(resolution, 'deleted')).toEqual([]);
  // A WHEREAS recital in a joint resolution is outside the title too.
  const joint = read(
    [
      COVER,
      'A JOINT RESOLUTION',
      'Proposing an amendment to the Constitution.',
      'The General Assembly of the Commonwealth of Pennsylvania',
      'hereby resolves as follows:',
      '(1) That section 3 of Article III be amended to read:',
      'Old [removed] text.',
    ].join('\n'),
  );
  expect(runs(joint, 'deleted')).toEqual(['[removed]']);
});

test('numbered gutters, line breaks and gaps in section numbers do not matter', () => {
  const doc = read(
    [
      COVER,
      'AN ACT',
      '1 Amending the act.',
      ENACT,
      'Section 1. Section 2 of the act is',
      '2 amended to read:',
      'A [first] word.',
      'Section 4. A [fourth] word.',
    ].join('\n'),
  );
  expect(runs(doc, 'deleted')).toEqual(['[first]', '[fourth]']);
});

test('a balanced bracket pair encloses several paragraphs and quoted sections', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 404 of the act is repealed:',
      '[Section 404. First.',
      '',
      'Section 405. Second.',
      '',
      'Section 406. Third.]',
      'Section 2. This act takes effect immediately.',
    ),
  );
  const deleted = runs(doc, 'deleted').join(' ');
  expect(deleted).toContain('Section 404. First.');
  expect(deleted).toContain('Section 405. Second.');
  expect(deleted).toContain('Section 406. Third.]');
  expect(deleted).not.toContain('takes effect');
});

test('an unmatched opening deletes only to the end of its paragraph and warns', () => {
  const doc = read(
    act(
      'Amending Title 75.',
      'Old [removed words',
      '',
      'A separate paragraph that stays.',
    ),
  );
  expect(runs(doc, 'deleted')).toEqual(['[removed words']);
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});

test('a rules resolution is amending; an ordinary resolution is not', () => {
  const rules = (title: string) =>
    pennsylvaniaAmendingBill(
      `${COVER}\nA RESOLUTION\n${title}\nRESOLVED, That the rules be adopted:\n[2023-2024]`,
    );
  expect(
    rules(
      'Adopting permanent rules for the House of Representatives,\nfurther providing for definitions.',
    ),
  ).toBe(true);
  expect(rules('Amending the rules of the Senate.')).toBe(true);
  expect(rules('Designating the week as "Sample Week" in Pennsylvania.')).toBe(
    false,
  );
});

test('a constitutional amendment title with a reference before "Constitution" is amending', () => {
  expect(
    pennsylvaniaAmendingBill(
      `${COVER}\nA JOINT RESOLUTION\nProposing an amendment to article two, section sixteen of the\nConstitution of the Commonwealth of Pennsylvania, reducing districts.\nThe General Assembly of the Commonwealth of Pennsylvania\nhereby resolves as follows:`,
    ),
  ).toBe(true);
});

test('a Pennsylvania text with brackets and no cover warns that nothing was verified', () => {
  const lines = [{ text: 'Section 1. The [old] words.' }];
  const result = applyChangeMarks(lines, context);
  expect(result.convention).toBe('default');
  expect(result.warnings.every(isLegendNotFoundWarning)).toBe(true);
  expect(result.warnings).toHaveLength(1);
  // Fail safe: a cover that amends nothing still warns about unclassified brackets.
  const act = applyChangeMarks(
    [
      { text: 'THE GENERAL ASSEMBLY OF PENNSYLVANIA' },
      { text: 'AN ACT' },
      { text: 'Providing for a [sic] sample.' },
    ],
    context,
  );
  expect(act.warnings).toHaveLength(1);
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

test('brackets inside verified inserted words stay literal', async () => {
  const doc = await parsePdf(await paPdf('inserted-bracket'), context);
  expect(runs(doc, 'inserted')).toEqual([
    'The form shall read "Name [optional]".',
  ]);
  expect(runs(doc, 'deleted')).toEqual(['[removed words]']);
});
