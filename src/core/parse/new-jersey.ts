import { EMPTY_METADATA, type BillMetadata } from '../model/index.js';
import {
  changeMarkConvention,
  changeMarkJurisdiction,
} from './change-marks.js';
import type { ChangeMarkContext } from './change-marks.js';

const SPONSOR_TITLE =
  /^(?:Senators?|Assembly(?:wo)?m[ae]n|Assembly\s+Members?|Assemblyperson|Assemblypersons)\s+/i;

/**
 * Printed NJ cover block, read deterministically. A bill is recognized by its own
 * "SENATE, No. 1000" / "ASSEMBLY, No. 3000" line plus either an official NJ source host or
 * the full NJ change legend, so an unrelated document that mentions New Jersey is left alone.
 * `legendText` lets a PDF caller supply the unfiltered text, where the footer legend still is.
 */
export function newJerseyMetadata(
  text: string,
  context: ChangeMarkContext,
  legendText: string = text,
): BillMetadata {
  const opening = text.slice(0, 2500);
  const designation =
    /^[ \t]*(SENATE|ASSEMBLY),[ \t]*No\.[ \t]*(\d{1,5})[ \t]*$/m.exec(opening);
  if (!designation || !/^[ \t]*STATE OF NEW JERSEY[ \t]*$/m.test(opening))
    return { ...EMPTY_METADATA };
  const njHost =
    changeMarkJurisdiction({ sourceUrl: context.sourceUrl }) === 'NJ';
  const legend =
    changeMarkConvention(legendText, {
      ...context,
      jurisdiction: 'New Jersey',
    }) === 'bracket-underline';
  if (!njHost && !legend) return { ...EMPTY_METADATA };

  const lines = opening.split('\n').map((line) => line.trim());
  const compact = opening.replace(/\s+/g, ' ');
  const titleStart = compact.indexOf('AN ACT ');
  const titleEnd = compact.indexOf('BE IT ENACTED', titleStart);
  const title =
    titleStart >= 0 && titleEnd > titleStart
      ? compact
          .slice(titleStart, titleEnd)
          // The title is printed as amended: bracketed words are already gone.
          .split(/[[\]]/)
          .filter((_part, index) => index % 2 === 0)
          .join('')
          .replace(/ {2,}/g, ' ')
          .trim()
      : null;
  const reprint = /\[\s*(First|Second|Third|Fourth|Fifth)\s+Reprint\s*\]/i.exec(
    opening,
  )?.[1];
  const legislature = /\b(\d{3}(?:st|nd|rd|th))\s+LEGISLATURE\b/i.exec(
    opening,
  )?.[1];

  // Primary sponsors only, as printed minus the title; co-sponsors follow "Co-Sponsored by".
  const start = lines.findIndex((line) => /^Sponsored by:?$/i.test(line));
  const sponsors: string[] = [];
  if (start >= 0)
    for (const line of lines.slice(start + 1)) {
      if (/^(?:Co-?Sponsored by|SYNOPSIS)\b/i.test(line)) break;
      if (SPONSOR_TITLE.test(line))
        sponsors.push(line.replace(SPONSOR_TITLE, '').trim());
    }
  return {
    ...EMPTY_METADATA,
    title,
    billNumber: `${designation[1] === 'SENATE' ? 'S' : 'A'}. ${designation[2] ?? ''}`,
    jurisdiction: 'New Jersey',
    session: legislature ? `${legislature} Legislature` : null,
    version: reprint
      ? `${reprint} Reprint`
      : /_T\d{1,2}\.(?:htm|pdf)$/i.test(new URL(context.sourceUrl).pathname)
        ? 'Technical Review'
        : 'Introduced',
    sponsors: sponsors.length > 0 ? sponsors : null,
    docKind: 'bill',
    source: 'structured',
  };
}
