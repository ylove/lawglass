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
  pennsylvaniaSections,
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
  expect(rules('Adopting temporary rules for the Senate.')).toBe(true);
  // Not chamber rules: another body's rules or federal law.
  expect(
    rules(
      'Urging the Congress to enact legislation amending the Fair Labor Standards Act.',
    ),
  ).toBe(false);
  expect(
    rules('Urging the agency to refrain from adopting rules on samples.'),
  ).toBe(false);
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

test('a pair never crosses into the next operative bill section: its opening is bounded and warns', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 3 of the act is amended to read:',
      'A literal [ stays only to its paragraph end.',
      '',
      'Current text of section one stays.',
      'Section 2. Section 4 of the act is amended to read:',
      'Text with a stray ] here.',
    ),
  );
  const deleted = runs(doc, 'deleted').join(' ');
  expect(deleted).toContain('[ stays only to its paragraph end.');
  expect(deleted).not.toContain('Current text of section one');
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});

test('an enacting clause wrapped between "of" and "Pennsylvania" still ends the title', () => {
  const text = [
    COVER,
    'AN ACT',
    'Providing for samples.',
    'The General Assembly of the Commonwealth of',
    'Pennsylvania hereby enacts as follows:',
    'Section 1. The bylaws are amending [rules] only as written.',
  ].join('\n');
  expect(pennsylvaniaAmendingBill(text)).toBe(false);
  expect(runs(read(text), 'deleted')).toEqual([]);
  // No verified boundary at all: not amending, and brackets warn instead of being decided silently.
  const open = [COVER, 'AN ACT', 'Amending the act [x].'].join('\n');
  expect(pennsylvaniaAmendingBill(open)).toBe(false);
  expect(read(open).warnings.length).toBeGreaterThan(0);
});

test('[Reserved] and [sic] are deleted wording in an amending PA measure', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 2 is amended to read:',
      'A [Reserved] and [sic] word.',
    ),
  );
  expect(runs(doc, 'deleted')).toEqual(['[Reserved]', '[sic]']);
});

test('a pair never crosses into the next operative bill section: its opening is bounded and warns', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 3 of the act is amended to read:',
      'A literal [ stays only to its paragraph end.',
      '',
      'Current text of section one stays.',
      'Section 2. Section 4 of the act is amended to read:',
      'Text with a stray ] here.',
    ),
  );
  const deleted = runs(doc, 'deleted').join(' ');
  expect(deleted).toContain('[ stays only to its paragraph end.');
  expect(deleted).not.toContain('Current text of section one');
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});

test('an enacting clause wrapped between "of" and "Pennsylvania" still ends the title', () => {
  const text = [
    COVER,
    'AN ACT',
    'Providing for samples.',
    'The General Assembly of the Commonwealth of',
    'Pennsylvania hereby enacts as follows:',
    'Section 1. The bylaws are amending [rules] only as written.',
  ].join('\n');
  expect(pennsylvaniaAmendingBill(text)).toBe(false);
  expect(runs(read(text), 'deleted')).toEqual([]);
  // No verified boundary at all: not amending, and brackets warn instead of being decided silently.
  const open = [COVER, 'AN ACT', 'Amending the act [x].'].join('\n');
  expect(pennsylvaniaAmendingBill(open)).toBe(false);
  expect(read(open).warnings.length).toBeGreaterThan(0);
});

test('[Reserved] and [sic] are deleted wording in an amending PA measure', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 2 is amended to read:',
      'A [Reserved] and [sic] word.',
    ),
  );
  expect(runs(doc, 'deleted')).toEqual(['[Reserved]', '[sic]']);
});

test('recovering many unmatched openings stays linear', () => {
  const body = Array.from(
    { length: 4000 },
    (_, i) => `word [open ${String(i)}`,
  );
  const started = performance.now();
  const doc = read(act('Amending the act.', ...body));
  expect(performance.now() - started).toBeLessThan(2000);
  expect(runs(doc, 'deleted').length).toBeGreaterThan(0);
});

test('a numbered gutter before "Section 1." is not read as the section number', () => {
  const doc = read(
    act(
      'Amending the act.',
      '10 Section 1. Section 3 of the act is amended to read:',
      'A literal [ opening.',
      '',
      'Section 2. Section 4 of the act is amended to read:',
      'Text with a stray ] here.',
    ),
  );
  expect(runs(doc, 'deleted').join(' ')).not.toContain('Section 2.');
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});

test('a lone closing bracket in unverified Pennsylvania text warns', () => {
  const result = applyChangeMarks([{ text: 'Old obligation]' }], context);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings.every(isLegendNotFoundWarning)).toBe(true);
});

test('a deletion outside quoted law warns; one after "to read:" does not', () => {
  const quoted = read(
    act(
      'Amending the act.',
      'Section 1. Section 3 of the act is amended to read:',
      'Old [removed] law.',
    ),
  );
  expect(runs(quoted, 'deleted')).toEqual(['[removed]']);
  expect(quoted.warnings).toEqual([]);
  const stray = read(
    act(
      'Amending the act.',
      'Section 1. Section 3 of the act is amended to read:',
      'Old law.',
      'Section 2. The form reads "Name [optional]". This act takes effect:',
      'immediately.',
    ),
  );
  expect(runs(stray, 'deleted')).toEqual(['[optional]']);
  expect(stray.warnings).toContainEqual(
    expect.stringMatching(/outside amended text/),
  );
  // A bracket before any operative section is unverified too.
  const early = read(
    act(
      'Amending the act.',
      'Preface [note].',
      'Section 1. Section 3 is amended to read:',
      'x',
    ),
  );
  expect(early.warnings).toContainEqual(
    expect.stringMatching(/outside amended text/),
  );
});

test('a rules resolution quotes law after its RESOLVED colon without a warning', () => {
  const doc = read(
    [
      COVER,
      'A RESOLUTION',
      'Adopting permanent rules for the House.',
      'RESOLVED, That the rules be adopted with the following amendments:',
      '[2023-2024] 2025-2026',
    ].join('\n'),
  );
  expect(runs(doc, 'deleted')).toEqual(['[2023-2024]']);
  expect(doc.warnings).toEqual([]);
});

/** Time of one parse, best of three to damp load noise. */
function timed(build: () => string): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const text = build();
    const started = performance.now();
    read(text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test.each([
  [
    'unmatched openings',
    (n: number) =>
      act(
        'Amending the act.',
        ...Array.from({ length: n }, (_, i) => `word [open ${String(i)}`),
        '',
      ),
  ],
  [
    'sections and bracket pairs',
    (n: number) =>
      act(
        'Amending the act.',
        ...Array.from({ length: n }, (_, i) => [
          `Section ${String(i + 1)}. Section 3 is amended to read:`,
          `Old [x${String(i)}] law.`,
        ]).flat(),
      ),
  ],
  [
    'a long resolution title',
    (n: number) =>
      [
        COVER,
        'A JOINT RESOLUTION',
        ...Array.from({ length: n }, () => 'proposing amendment words'),
        ENACT,
      ].join('\n'),
  ],
])(
  '%s: four times the input takes well under sixteen times as long',
  (_name, build) => {
    const small = timed(() => build(4000));
    const large = timed(() => build(16000));
    // Linear would be about 4x; quadratic about 16x. Allow generous noise.
    expect(large).toBeLessThan(Math.max(small, 30) * 10);
  },
);

test('sections without an operative phrase and decimal sections are still boundaries', () => {
  const lines = [
    'Section 1. Section 3 of the act is amended to read:',
    'Old [x] law.',
    'Section 2. Any regulations are abrogated.',
    'Section 2.1. A decimal section.',
    'Section 3. Section 5 of the act is amended to read:',
    'Section 7. Section 9 is amended to read:',
  ];
  const sections = pennsylvaniaSections(lines);
  expect(sections.map((x) => x.start)).toHaveLength(5);
  // The non-operative section verifies nothing.
  expect(sections[1]?.quotedFrom).toBe(Infinity);
  // A look-ahead never borrows words from the next section.
  expect(
    pennsylvaniaSections([
      'Section 1. Plain.',
      'Section 2. This act shall take effect:',
    ])[0]?.quotedFrom,
  ).toBe(Infinity);
});

test('a crossing pair through an undetected-style section (HB 150 shape) and a plain new section both warn', () => {
  const crossing = read(
    act(
      'Amending the act.',
      'Section 1. Section 3 of the act is amended to read:',
      'Old [law that is opened',
      'Section 2. Any regulations are abrogated.',
      'Section 3. This act takes effect immediately.]',
    ),
  );
  expect(crossing.warnings).toContainEqual(expect.stringMatching(/not closed/));
  expect(runs(crossing, 'deleted').join(' ')).not.toContain('abrogated');
  const optional = read(
    act(
      'Amending the act.',
      'Section 1. Section 3 of the act is amended to read:',
      'Old [removed] law.',
      'Section 2. The form reads "Name [optional]".',
    ),
  );
  expect(runs(optional, 'deleted')).toEqual(['[removed]', '[optional]']);
  expect(optional.warnings).toContainEqual(
    expect.stringMatching(/outside amended text/),
  );
});

test('a quoted heading that shadows the next bill number cannot hide the real section (K)', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 2 of the act is amended to read:',
      'Section 2. Definitions.',
      '"Fee." The [ten] twenty dollar fee.',
      'Section 2. The survey form shall read "Name [optional]".',
      'Section 3. This act shall take effect in 60 days.',
    ),
  );
  expect(runs(doc, 'deleted')).toContain('[optional]');
  expect(doc.warnings).toContainEqual(
    expect.stringMatching(/outside amended text/),
  );
});

test('a pair cannot run across the real section after a shadowing heading (L)', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 2 of the act is amended to read:',
      'Section 2. Definitions.',
      '"Fee." The fee is [ten twenty dollars.',
      'Section 2. Section 5 of the act is amended to read:',
      'Section 5. Terms.',
      'The term is six] years.',
      'Section 3. This act shall take effect in 60 days.',
    ),
  );
  expect(runs(doc, 'deleted').join(' ')).not.toContain('The term is six');
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});

test('an old-style quoted heading with ".--" is still ignored (M)', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Section 2 of the act is amended to read:',
      'Section 2. Findings.--The [old] findings.',
      'Section 2. This act shall take effect immediately.',
    ),
  );
  expect(runs(doc, 'deleted')).toEqual(['[old]']);
  expect(doc.warnings).toEqual([]);
});

test('an ordinary resolution with brackets warns that it is not an amending measure', () => {
  const doc = read(
    [
      COVER,
      'A RESOLUTION',
      'Designating a week.',
      'RESOLVED, That the [x] week.',
    ].join('\n'),
  );
  expect(runs(doc, 'deleted')).toEqual([]);
  expect(doc.warnings.join(' ')).toMatch(/not an amending measure/);
  expect(doc.warnings.join(' ')).not.toMatch(/cover was not found/);
});

const shadow = (directive: string, heading: string, ...rest: string[]) =>
  read(
    act(
      'Amending the act.',
      directive,
      heading,
      'The following words and phrases have these meanings:',
      ...rest,
    ),
  );

test('a resync that skipped a number still bounds the real section (N)', () => {
  const doc = shadow(
    'Section 1. Section 5 of the act is amended to read:',
    'Section 5. Definitions.',
    '"Fee." The [ten] twenty dollar fee.',
    'Section 2. The survey form shall read "Name [optional]".',
    'Section 3. This act shall take effect in 60 days.',
  );
  expect(runs(doc, 'deleted')).toContain('[optional]');
  expect(doc.warnings).toContainEqual(
    expect.stringMatching(/outside amended text/),
  );
});

test('a pair cannot run across the real section after a resync (O)', () => {
  const doc = shadow(
    'Section 1. Section 5 of the act is amended to read:',
    'Section 5. Definitions.',
    '"Fee." The fee is [ten twenty dollars.',
    'Section 2. Section 7 of the act is amended to read:',
    'Section 7. Terms.',
    'The term is six] years.',
    'Section 3. This act shall take effect in 60 days.',
  );
  expect(runs(doc, 'deleted').join(' ')).not.toContain('The term is six');
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});

test('chained resyncs keep every skipped number bounded (P)', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Sections 4, 7 and 10 of the act are amended to read:',
      'Section 4. Definitions. The following words:',
      'Section 7. Terms. The following terms:',
      'Section 10. Fees. The following fees:',
      'Section 2. The survey form shall read "Name [optional]".',
      'Section 3. The form reads "Other [thing]".',
    ),
  );
  expect(runs(doc, 'deleted')).toEqual(['[optional]', '[thing]']);
  expect(doc.warnings).toContainEqual(
    expect.stringMatching(/outside amended text/),
  );
});

test('the overlap warning counts drawn underlines, not capital-letter runs', () => {
  const underlined = applyChangeMarks(
    [
      { text: 'THE GENERAL ASSEMBLY OF PENNSYLVANIA' },
      { text: 'AN ACT' },
      { text: 'Amending the act.' },
      { text: 'The General Assembly of the Commonwealth of Pennsylvania' },
      { text: 'Section 1. Section 2 is amended to read:' },
      {
        text: 'Old [kept words] here.',
        statuses: 'Old [kept words] here.'
          .split('')
          .map((_c, at) => (at >= 5 && at < 9 ? 'inserted' : 'unchanged')),
      },
    ],
    context,
  );
  expect(underlined.warnings).toContainEqual(
    expect.stringMatching(/Underlined wording/),
  );
  const capitals = read(
    [
      COVER,
      "PRIOR PRINTER'S NOS. 1",
      'AN ACT',
      'Amending the act.',
      ENACT,
      'Section 1. Section 2 is amended to read:',
      'Old [LOCAL RESOURCE MANUFACTURING AREA] words.',
    ].join('\n'),
  );
  expect(runs(capitals, 'deleted')).toEqual([
    '[LOCAL RESOURCE MANUFACTURING AREA]',
  ]);
  expect(capitals.warnings.join(' ')).not.toMatch(/Underlined wording/);
});

test('consecutive exactly matching quoted headings cannot hide the real section (Q)', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Sections 2, 3, 4 and 5 of the act are amended to read:',
      'Section 2. Short title.',
      'Section 3. Definitions.',
      'Section 4. Terms.',
      'Section 5. Fees.',
      '(1) A permit fee of [ten] twenty dollars.',
      'Section 2. The survey form shall read "Name [optional]".',
      'Section 3. This act shall take effect in 60 days.',
    ),
  );
  expect(runs(doc, 'deleted')).toContain('[optional]');
  expect(doc.warnings).toContainEqual(
    expect.stringMatching(/outside amended text/),
  );
});

test('a pair cannot cross the real section after consecutive quoted headings (R)', () => {
  const doc = read(
    act(
      'Amending the act.',
      'Section 1. Sections 2, 3, 4 and 5 of the act are amended to read:',
      'Section 2. Short title.',
      'Section 3. Definitions.',
      'Section 4. Terms.',
      'Section 5. Fees.',
      '(1) A permit fee of [ten twenty dollars.',
      'Section 2. Section 12 of the act is amended to read:',
      'Section 12. Terms.',
      'The term is six] years.',
      'Section 3. This act shall take effect in 60 days.',
    ),
  );
  expect(runs(doc, 'deleted').join(' ')).not.toContain('The term is six');
  expect(doc.warnings).toContainEqual(expect.stringMatching(/not closed/));
});
