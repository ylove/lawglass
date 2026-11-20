import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Invented Pennsylvania-style bills. Pennsylvania prints no legend on the bill; its marks are
 * the ones the legislature's "Explanation to facilitate reading of legislative bills" lists:
 * [brackets] for old law to omit, underscoring for new law, strike-out type and CAPITAL LETTERS
 * for amendments made to a bill, and a "<--" pointer beside changed lines. Nothing here is real
 * legislation.
 */
export type PaSample = 'amending' | 'amended-new-act' | 'resolution';

const COVER = [
  'THE GENERAL ASSEMBLY OF PENNSYLVANIA',
  'HOUSE BILL',
  'Session of',
  'No. 9001 2026',
  'INTRODUCED BY EXAMPLE, SAMPLE AND PLACEHOLDER, MARCH 3, 2026',
  'REFERRED TO TRANSPORTATION, MARCH 3, 2026',
];

/** The text form of the amending bill, as the PDF's text layer reads. */
export function paAmendingText(): string {
  return [
    "PRINTER'S NO. 9001",
    ...COVER,
    'AN ACT',
    'Amending Title 75 (Vehicles) of the Pennsylvania Consolidated',
    'Statutes, further providing for sample permits.',
    'The General Assembly of the Commonwealth of Pennsylvania',
    'hereby enacts as follows:',
    'Section 1. Section 1111(a) of Title 75 is amended to read:',
    '§ 1111. Sample permits.',
    '(a) General rule.--A person may hold a permit [for ten years] for',
    'twelve years if the department approves it.',
    '* * *',
    'Section 2. This act shall take effect in 60 days.',
  ].join('\n');
}

/**
 * A generated PDF. `amending`: brackets for deleted old law, underlined new law, a "<--"
 * pointer and an underlined cover rule. `amended-new-act`: a new act amended in the Senate, with
 * struck text, capital-letter insertions and a literal bracket in its own text. `resolution`:
 * a plain resolution that quotes a bracketed editorial note.
 */
export async function paPdf(
  sample: PaSample = 'amending',
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const font = await doc.embedFont(StandardFonts.Courier);
  const page = doc.addPage([612, 792]);
  const width = 6; // Courier at 10 pt
  let y = 740;
  const line = (text: string): void => {
    page.drawText(text, { x: 72, y, size: 10, font });
    y -= 15;
  };
  /** One line made of plain, underlined and struck pieces: [kind, text]. */
  const marked = (
    pieces: readonly (readonly ['p' | 'u' | 's', string])[],
  ): void => {
    let x = 72;
    for (const [kind, text] of pieces) {
      page.drawText(text, { x, y, size: 10, font });
      if (kind !== 'p')
        page.drawLine({
          start: { x, y: kind === 'u' ? y - 2 : y + 3 },
          end: { x: x + text.length * width, y: kind === 'u' ? y - 2 : y + 3 },
          thickness: 0.6,
        });
      x += text.length * width;
    }
    y -= 15;
  };

  if (sample === 'amended-new-act') line('SENATE AMENDED');
  if (sample !== 'resolution' && sample === 'amended-new-act')
    marked([['u', "PRIOR PRINTER'S NO. 9002"]]);
  marked([
    ['p', "PRINTER'S NO. "],
    ['u', sample === 'amended-new-act' ? '9005' : '9001'],
  ]);
  for (const text of COVER) {
    line(
      sample === 'resolution'
        ? text.replace('HOUSE BILL', 'HOUSE RESOLUTION').replace('9001', '77')
        : text,
    );
  }
  if (sample === 'amending') {
    line('AN ACT');
    line('Amending Title 75 (Vehicles) of the Pennsylvania Consolidated');
    line('Statutes, further providing for sample permits.');
    line('The General Assembly of the Commonwealth of Pennsylvania');
    line('hereby enacts as follows:');
    line('Section 1. Section 1111(a) of Title 75 is amended to read:');
    line('§ 1111. Sample permits.');
    marked([
      ['p', '(a) General rule.--A person may hold a permit '],
      ['p', '[for ten years]'],
      ['p', ' '],
      ['u', 'for twelve years'],
      ['p', ' if'],
    ]);
    line('the department approves it.');
    line('* * *');
    line('Section 2. This act shall take effect in 60 days.');
  } else if (sample === 'amended-new-act') {
    line('AN ACT');
    line('Providing for a sample fee.');
    line('The General Assembly of the Commonwealth of Pennsylvania');
    line('hereby enacts as follows:');
    line('Section 1. Short title.');
    line('This act shall be known as the Sample Fee Act. [sic]');
    line('Section 2. Fee.');
    marked([
      ['p', 'A court shall impose a fee '],
      ['s', 'in every case'],
    ]);
    line('ON EACH COVERED OFFENSE <--');
    line('and the court may waive it.');
    line('Section 3. This act shall take effect immediately.');
  } else {
    line('A RESOLUTION');
    line(
      'Designating the week of May 4, 2026, as "Sample Week" in Pennsylvania.',
    );
    line('WHEREAS, Samples are valued [by the Commonwealth]; therefore be it');
    line('RESOLVED, That the House of Representatives designate the week.');
  }
  return doc.save();
}
