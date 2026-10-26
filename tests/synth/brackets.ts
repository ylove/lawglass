import { PDFDocument, StandardFonts } from 'pdf-lib';

export const NY_LEGEND =
  'EXPLANATION--Matter in italics (underscored) is new; matter in brackets [ ] is old law to be omitted.';
export const NJ_LEGEND =
  'EXPLANATION – Matter enclosed in bold-faced brackets [thus] in the above bill is not enacted and is intended to be omitted in the law. Matter underlined thus is new matter.';

export function bracketText(legend = NY_LEGEND): string {
  return [
    'STATE OF NEW YORK',
    'S. 4321--A',
    '2025-2026 Regular Sessions',
    'Introduced by Sen. EXAMPLE -- read twice and ordered printed',
    'AN ACT to amend the public health law, in relation to sample notices',
    'The People of the State of New York, represented in Senate and Assembly, do enact as follows:',
    legend,
    'Section 1. Notices.',
    '1. The notice [old (including [nested] punctuation),',
    'Section 99. Repealed heading',
    'continues across the page] is replaced.',
    '(a) [Reserved] and [sic] remain; see [42 U.S.C. 1983] and [123 N.Y.2d 456].',
    '(i) A value changes from [3] to 4.',
    '§ 2. Effective date.',
  ].join('\n');
}

export function bracketHtml(legend = NY_LEGEND): string {
  return `<pre>${bracketText(legend)
    .replace('[old', '[<b>old</b>')
    .replace(
      'continues across the page]',
      '<span>continues across the page</span>]',
    )
    .replace(
      'is replaced.',
      'is <i>replaced</i> and <u>underlined</u>.',
    )}</pre>`;
}

/** Generated PDF, with a bracket crossing a page and independent italic/underline additions. */
export async function bracketPdf(
  legend: boolean | 'NJ' = true,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const font = await doc.embedFont(StandardFonts.Courier);
  const italic = await doc.embedFont(StandardFonts.CourierOblique);
  const first = doc.addPage([612, 792]);
  const second = doc.addPage([612, 792]);
  const draw = (
    page: typeof first,
    text: string,
    y: number,
    line?: number,
  ): void => {
    page.drawText(text, { x: 72, y, size: 10, font });
    if (line) page.drawText(String(line), { x: 40, y, size: 10, font });
  };
  draw(
    first,
    legend === 'NJ' ? 'STATE OF NEW JERSEY' : 'STATE OF NEW YORK',
    720,
  );
  draw(first, 'S. 4321--A', 700);
  draw(
    first,
    legend === 'NJ'
      ? 'Matter enclosed in superscript numerals has been adopted as follows:'
      : '2025-2026 Regular Sessions',
    680,
  );
  if (legend === 'NJ') {
    draw(
      first,
      'EXPLANATION - Matter enclosed in bold-faced brackets [thus]',
      660,
    );
    draw(
      first,
      'in the above bill is not enacted and is intended to be omitted',
      645,
    );
    draw(first, 'in the law. Matter underlined thus is new matter.', 630);
  } else if (legend) {
    draw(first, 'EXPLANATION--Matter in italics (underscored) is new;', 660);
    draw(first, 'matter in brackets [ ] is old law to be omitted.', 645);
  }
  draw(first, 'Section 1. Notices.', 610, 1);
  draw(first, '1. The [old wording', 590, 2);
  draw(first, 'Section 99. Repealed heading', 570, 3);
  if (legend === 'NJ') {
    first.drawText('1', { x: 110, y: 595, size: 6, font });
    second.drawText('1', { x: 156, y: 645, size: 6, font });
  }
  draw(second, 'continues here] now applies.', 640, 4);
  draw(second, '(a) [Reserved] and [sic]; see [42 U.S.C. 1983].', 620, 5);
  draw(second, '(i) New wording: ', 600, 6);
  second.drawText('italic addition', {
    x: 168,
    y: 600,
    size: 10,
    font: italic,
  });
  draw(second, 'underlined addition', 580, 7);
  second.drawLine({
    start: { x: 72, y: 578 },
    end: { x: 186, y: 578 },
    thickness: 0.6,
  });
  draw(second, 'Section 2. Effective date.', 560, 8);
  return doc.save();
}
