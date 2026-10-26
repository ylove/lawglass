import { EMPTY_METADATA, type BillMetadata } from '../model/index.js';
import {
  DEFAULT_SECTION_PATTERNS,
  type GateLine,
  type SectionDetectionOptions,
  type SectionGate,
} from './sections.js';
import {
  changeMarkJurisdiction,
  changeMarkConvention,
  type ChangeMarkContext,
} from './change-marks.js';

/**
 * Bills of these states have exactly one container level: the bill's own numbered sections.
 * "chapter 397 of the laws of 2021" or "article 6 of the labor law" at the start of a wrapped
 * line is prose about the amended law, so article/chapter patterns are never used.
 */
const BILL_PATTERNS = DEFAULT_SECTION_PATTERNS.filter(
  (pattern) => pattern.kind !== 'article' && pattern.kind !== 'chapter',
);
/** Skipping a little tolerates a missed line; a big jump is a quoted statute's own number. */
const MAX_SECTION_SKIP = 3;

/** What a real bill section says in its opening lines, as opposed to quoted statute text. */
const BILL_SECTION_OPENING =
  /\b(?:is|are|be) (?:hereby )?(?:amended|supplemented|repealed|revised)\b|\(New section\)|\bnew sections?\b|\btake effect|\bseverability\b|\bIf any (?:clause|provision|section|part)\b|\bis added\b/i;
/** NJ only: an opening that can safely end a quote whose "(cf: ...)" was not printed. */
const AMENDING_OPENING =
  /\b(?:is|are) (?:hereby )?(?:amended|supplemented|repealed)\b|\(New section\)|\bThis act shall take effect\b/i;
/** Without "as follows", this many lines are the opening: enough to reach a wrapped change mark. */
const UNQUOTED_CLAUSE_LINES = 4;
const PART_LINE = /^\s*PART\s+([A-Z]{1,3})\s*$/;
/** Printed text keeps its wrap spacing, so words may be separated by several spaces. */
const QUOTE_OPENER = /\bread\s+as\s+follows\b/i;
/** A line that starts what the patterns would open as a section. */
/** Capitalised and numbered: a wrapped "section two of this act" is not an opener. */
const SECTION_OPENER =
  /^\s*(?:§\s*\d|(?:Section|SECTION|Sec\.|SEC\.)\s+\d|\d+\.\s)/;
const OWN_MARKER =
  /^\s*(?:(?:Section|SECTION|Sec\.?|SEC\.?)\s+|§\s*)?\d+(?:-[a-z])?\.?\s*/;
/**
 * "Section 4", "Sections 3, 4 and 9", "a new section 3": the statute sections an amending
 * clause names. A hyphenated number such as "11-2204" is an administrative-code section, not
 * bill section 11, and is skipped.
 */
const SECTION_REFS =
  /\bsections?\s+(\d+(?:-\w+)?(?:(?:,\s*|,?\s+(?:and|through|to)\s+)\d+(?:-\w+)?)*)/i;

interface OpeningClause {
  /** The text from the marker to the end of the clause, without the marker itself. */
  text: string;
  /** The clause ends in "read as follows": the lines after it quote law. */
  quotes: boolean;
  /** Any change mark in the clause. A bill's own section openers are printed plain. */
  marked: boolean;
}

/**
 * The opening clause runs to the first "as follows", however many lines it wraps over, and
 * stops early at a line that opens another section. Without "as follows" it is a few lines.
 */
function openingClause(lines: readonly GateLine[]): OpeningClause {
  const taken: { text: string; changed: readonly boolean[] }[] = [];
  let quotes = false;
  for (const [index, line] of lines.entries()) {
    if (index > 0 && SECTION_OPENER.test(line.text)) break;
    const before = taken.map((entry) => entry.text).join(' ');
    const joined = `${before}${index > 0 ? ' ' : ''}${line.text}`;
    const opener = QUOTE_OPENER.exec(joined);
    if (opener) {
      // Text after "as follows" on the same line is already the quoted law.
      const keep =
        opener.index + opener[0].length - (joined.length - line.text.length);
      taken.push({
        text: line.text.slice(0, keep),
        changed: line.changed.slice(0, keep),
      });
      quotes = true;
      break;
    }
    taken.push(line);
  }
  const clause = quotes ? taken : taken.slice(0, UNQUOTED_CLAUSE_LINES);
  return {
    text: clause
      .map((line) => line.text)
      .join(' ')
      .replace(OWN_MARKER, '')
      .replace(/\s+/g, ' '),
    quotes,
    marked: clause.some((line) => line.changed.some(Boolean)),
  };
}

function quotedSectionNumbers(clause: OpeningClause): Set<number> {
  const numbers = new Set<number>();
  if (!clause.quotes) return numbers;
  // Only the first reference is the amended section; later ones ("as added by section 2 of
  // part B of chapter 56") are other laws' numbers and would swallow the bill's real section 2.
  const refs = SECTION_REFS.exec(clause.text)?.[1] ?? '';
  for (const [number] of refs.matchAll(/\d+(?:-\w+)?/g))
    if (!number.includes('-')) numbers.add(Number(number));
  return numbers;
}

/**
 * Bill sections count 1, 2, 3...; `§ 424-c.` or `§ 1200.` inside inserted law is text.
 * A section that quotes an amended law ("Section 2 of P.L.1985 is amended to read as
 * follows:") is followed by that law's own `2.` or `§ 3.`. A marker is a quoted section when:
 * - NJ: it comes before the quote's closing "(cf: ...)" (bill sections then continue);
 * - it carries a number the amending clause named, unless it opens like a bill section
 *   ("This act shall take effect") with no change marks;
 * - NY: it follows an amending clause and its opening is marked up, since a bill's own section
 *   openers are plain text and the change marks belong to the quoted law.
 * `§ 1-a.` is accepted beside `§ 1`. Omnibus and budget bills restart at each PART.
 */
function billSectionGate(state: 'NY' | 'NJ'): SectionGate {
  let last = 0;
  let part: string | undefined;
  /** Statute section numbers named by the last bill section's clause, not yet seen quoted. */
  let named = new Set<number>();
  /** The last bill section opened a quote, so markers after it may be that quote's. */
  let quoteOpen = false;
  /** NJ only: a quote is open until its "(cf: ...)" line. */
  let beforeCf = false;
  return {
    observe(lineText) {
      const partLine = PART_LINE.exec(lineText);
      if (partLine) {
        part = `Part ${partLine[1] ?? ''}`;
        last = 0;
        named = new Set();
        quoteOpen = beforeCf = false;
      }
      if (state === 'NJ' && lineText.includes('(cf:')) beforeCf = false;
    },
    qualifier: () => part,
    accept(marker, lines) {
      const addendum = /^(\d+)-[a-z]$/i.exec(marker);
      if (!addendum && !/^\d+$/.test(marker)) return false;
      const number = Number(addendum ? addendum[1] : marker);
      if (
        addendum
          ? number !== last
          : number <= last || number > last + MAX_SECTION_SKIP
      )
        return false;
      const clause = openingClause(lines);
      const looksQuoted =
        (state === 'NJ' && beforeCf
          ? !(number === last + 1 && AMENDING_OPENING.test(clause.text))
          : named.has(number) &&
            (clause.marked || !BILL_SECTION_OPENING.test(clause.text))) ||
        (state === 'NY' && quoteOpen && clause.marked);
      if (looksQuoted) {
        named.delete(number);
        return false;
      }
      last = number;
      named = quotedSectionNumbers(clause);
      quoteOpen = clause.quotes;
      beforeCf = state === 'NJ' && clause.quotes;
      return true;
    },
  };
}

/**
 * NY: `Section 1.` / `§ 2.` open bill sections; `1.` and `(a)` are subdivisions.
 * NJ: `1.` at a line start opens a bill section; `a.` and `(1)` are subdivisions.
 */
export function jurisdictionSections(
  options: SectionDetectionOptions & ChangeMarkContext,
): SectionDetectionOptions {
  if (options.patterns) return options;
  const state = changeMarkJurisdiction(options);
  if (state === 'NY')
    return {
      patterns: [
        ...BILL_PATTERNS,
        { kind: 'enumeration', regex: /^(\d{1,2})\.(?=\s|$)/ },
      ],
      createSectionGate: () => billSectionGate('NY'),
      shortSectionHeadings: true,
    };
  if (state === 'NJ')
    return {
      patterns: [
        {
          kind: 'section',
          regex: /^(\d+)\.(?=\s|$)(?!\s+(?:of|and|or|to|through)\b)/,
        },
        ...BILL_PATTERNS.filter((pattern) => pattern.kind === 'enumeration'),
        // A wrapped "subsection\nb. of this section" is a cross-reference, not subsection b.
        {
          kind: 'enumeration',
          regex: /^([a-z])\.(?=\s)(?!\s+(?:of|and|or|to|through)\b)/,
        },
        // The explanatory statement printed after the last bill section is not law text.
        { kind: 'article', regex: /^(STATEMENT)$/ },
      ],
      nestRestartedMarkers: true,
      createSectionGate: () => billSectionGate('NJ'),
      shortSectionHeadings: true,
    };
  return options;
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
