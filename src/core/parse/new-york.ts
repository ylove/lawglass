import { EMPTY_METADATA, type BillMetadata } from '../model/index.js';
import {
  DEFAULT_SECTION_PATTERNS,
  type SectionDetectionOptions,
} from './sections.js';
import {
  changeMarkJurisdiction,
  changeMarkConvention,
  type ChangeMarkContext,
} from './change-marks.js';

/** NY subdivisions use `1.` as well as parenthesized paragraph/subparagraph markers. */
export function jurisdictionSections(
  options: SectionDetectionOptions & ChangeMarkContext,
): SectionDetectionOptions {
  if (options.patterns || changeMarkJurisdiction(options) !== 'NY')
    return options;
  return {
    patterns: [
      ...DEFAULT_SECTION_PATTERNS,
      { kind: 'enumeration', regex: /^(\d+)\.(?=\s|$)/ },
    ],
  };
}

/** Printed NY title blocks; model extraction fills only fields still null. */
export function newYorkMetadata(
  text: string,
  context: ChangeMarkContext,
): BillMetadata {
  // A mention in a jurat or quoted law is not a bill header. Mirrors need both a
  // state/chamber header near the start and the complete NY amendment legend.
  const opening = text.slice(0, 2000);
  const nyHost =
    changeMarkJurisdiction({ sourceUrl: context.sourceUrl }) === 'NY';
  const nyHeader =
    /^[ \t]*STATE OF NEW YORK[ \t]*$/m.test(opening) &&
    /^[ \t]*IN (?:SENATE|ASSEMBLY)[ \t]*$/m.test(opening) &&
    changeMarkConvention(text, { ...context, jurisdiction: 'New York' }) ===
      'bracket-underline';
  if (!nyHost && !nyHeader) return { ...EMPTY_METADATA };
  // Never search bill prose for a sponsor/title.
  const compact = opening.replace(/\s+/g, ' ');
  const titleStart = compact.indexOf('AN ACT ');
  const titleEnd = compact.indexOf(
    'The People of the State of New York',
    titleStart,
  );
  const title =
    titleStart >= 0 && titleEnd > titleStart
      ? compact.slice(titleStart, titleEnd).trim()
      : null;
  const printed = /\b([SA])\.\s*(\d+)(?:\s*--\s*([A-Z]))?\b/.exec(compact);
  const bare = opening
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^\d+(?:\s*--\s*[A-Z])?$/.test(line));
  const chamber = compact.includes('IN SENATE')
    ? 'S'
    : compact.includes('IN ASSEMBLY')
      ? 'A'
      : undefined;
  const designation = printed
    ? `${printed[1] ?? ''}. ${printed[2] ?? ''}${printed[3] ?? ''}`
    : bare && chamber
      ? `${chamber}. ${bare.replace(/\s/g, '').replace('--', '')}`
      : null;
  const amendment = printed?.[3] ?? /--\s*([A-Z])$/.exec(bare ?? '')?.[1];
  const sponsorStart =
    /Introduced by (?:Sens?\.|Senators?|M\.? of A\.?) /i.exec(compact);
  const sponsorRest = sponsorStart
    ? compact.slice(sponsorStart.index + sponsorStart[0].length)
    : '';
  const sponsorEnd = sponsorRest.indexOf('--');
  const sponsorLine =
    sponsorEnd >= 0 ? sponsorRest.slice(0, sponsorEnd).trim() : '';
  return {
    ...EMPTY_METADATA,
    title,
    billNumber: designation,
    jurisdiction: 'New York',
    session: /\b\d{4}-\d{4} Regular Sessions\b/.exec(compact)?.[0] ?? null,
    version: designation
      ? amendment
        ? `Amended (${amendment})`
        : 'Introduced'
      : null,
    sponsors: sponsorLine
      ? sponsorLine
          .split(/,|\band\b/)
          .map((name) => name.trim())
          .filter(Boolean)
      : null,
    docKind: 'bill',
    source: 'structured',
  };
}
