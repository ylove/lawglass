import { EMPTY_METADATA, type BillMetadata } from '../model/index.js';
import {
  changeMarkJurisdiction,
  pennsylvaniaAmendingBill,
} from './change-marks.js';
import type { ChangeMarkContext } from './change-marks.js';

/** The printed cover names the chamber and kind: "HOUSE BILL", "SENATE RESOLUTION". */
const DESIGNATION = /^[ \t]*(HOUSE|SENATE)[ \t]+(BILL|RESOLUTION)[ \t]*$/m;
/** "No. 2443 2026": the number, then the year this copy was printed (not the session). */
const NUMBER = /^[ \t]*No\.[ \t]*(\d{1,5})[ \t]+\d{4}[ \t]*$/m;
/** What the measure calls itself under the bill/resolution cover line. */
const KIND_LINE =
  /^[ \t]*(AN ACT|A RESOLUTION|A JOINT RESOLUTION|A CONCURRENT RESOLUTION)[ \t]*$/m;
/** Where the title ends: the enacting or resolving words, or the first recital. */
const TITLE_END =
  /^[ \t]*(?:The General Assembly of the Commonwealth|WHEREAS\b|RESOLVED\b)/m;
const URL_SESSION = /\/text\/(?:PDF|HTM|DOC)\/(\d{4})\/(\d)\//i;
const URL_PRINTER = /\/PN0*(\d{1,5})$/i;

/** Session labels as the site prints them: "2025-2026 Regular Session". */
export function pennsylvaniaSessionLabel(year: number, index: number): string {
  const span = `${String(year)}-${String(year + 1)}`;
  return index === 0
    ? `${span} Regular Session`
    : `${span} Special Session #${String(index)}`;
}

/**
 * Printed PA cover block, read deterministically. A document is recognized by its own
 * "HOUSE BILL" / "SENATE RESOLUTION" line under "THE GENERAL ASSEMBLY OF PENNSYLVANIA" plus
 * either an official PA source host or an amending bill, so an unrelated document that
 * mentions Pennsylvania is left alone. `text` must already have struck-through words removed:
 * an amended print still shows the earlier title words, struck.
 */
export function pennsylvaniaMetadata(
  text: string,
  context: ChangeMarkContext,
): BillMetadata {
  const opening = text.slice(0, 3000);
  const designation = DESIGNATION.exec(opening);
  const number = NUMBER.exec(opening);
  if (
    !designation ||
    !number ||
    !/THE\s+GENERAL\s+ASSEMBLY\s+OF\s+PENNSYLVANIA/.test(opening)
  )
    return { ...EMPTY_METADATA };
  const paHost =
    changeMarkJurisdiction({ sourceUrl: context.sourceUrl }) === 'PA';
  if (!paHost && !pennsylvaniaAmendingBill(text)) return { ...EMPTY_METADATA };

  const house = designation[1] === 'HOUSE';
  const resolution = designation[2] === 'RESOLUTION';
  // A joint resolution is numbered like a bill (SB 605) but is a resolution by kind.
  const kind = KIND_LINE.exec(opening);
  const isResolution = resolution || (kind?.[1] ?? '').includes('RESOLUTION');
  const code = `${house ? 'H' : 'S'}${resolution ? 'R' : 'B'}`;

  let title: string | null = null;
  if (kind) {
    const rest = opening.slice(kind.index + kind[0].length);
    const end = TITLE_END.exec(rest);
    const body = end ? rest.slice(0, end.index) : '';
    title = body.replace(/\s+/g, ' ').trim() || null;
  }

  // "INTRODUCED BY A, B AND C, APRIL 21, 2026": the first name is the prime sponsor.
  const introduced = /^[ \t]*INTRODUCED BY (.+)$/m.exec(opening)?.[1] ?? '';
  const sponsor = introduced.split(/,| AND /)[0]?.trim();

  const url = new URL(context.sourceUrl);
  const sessionMatch = URL_SESSION.exec(url.pathname);
  const printer =
    URL_PRINTER.exec(url.pathname)?.[1] ??
    /PRINTER'S\s+NO\.?\s*(\d{1,5})/.exec(opening)?.[1];
  return {
    ...EMPTY_METADATA,
    title,
    billNumber: `${code} ${String(Number(number[1]))}`,
    jurisdiction: 'Pennsylvania',
    session: sessionMatch
      ? pennsylvaniaSessionLabel(
          Number(sessionMatch[1]),
          Number(sessionMatch[2]),
        )
      : null,
    version: printer ? `Printer's No. ${String(Number(printer))}` : null,
    sponsors: sponsor ? [sponsor] : null,
    docKind: isResolution ? 'resolution' : 'bill',
    source: 'structured',
  };
}
