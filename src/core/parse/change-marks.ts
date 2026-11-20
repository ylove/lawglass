import type { SpanStatus } from '../model/index.js';
import type { SourceLine } from './sections.js';

/** Parser policy, deliberately outside the frozen document contracts. */
export type ChangeMarkConvention = 'default' | 'bracket-underline';
export interface ChangeMarkContext {
  sourceUrl: string;
  jurisdiction?: string;
}

const NY_HOSTS = new Set([
  'nysenate.gov',
  'www.nysenate.gov',
  'legislation.nysenate.gov',
  'nyassembly.gov',
  'www.nyassembly.gov',
]);
const NJ_HOSTS = new Set([
  'njleg.gov',
  'www.njleg.gov',
  'pub.njleg.gov',
  'njleg.state.nj.us',
  'www.njleg.state.nj.us',
  'pub.njleg.state.nj.us',
]);

const PA_HOSTS = new Set([
  'palegis.us',
  'www.palegis.us',
  'legis.state.pa.us',
  'www.legis.state.pa.us',
]);

export function changeMarkJurisdiction(
  context: ChangeMarkContext,
): 'NY' | 'NJ' | 'PA' | undefined {
  const host = new URL(context.sourceUrl).hostname;
  if (NY_HOSTS.has(host) || context.jurisdiction === 'New York') return 'NY';
  if (NJ_HOSTS.has(host) || context.jurisdiction === 'New Jersey') return 'NJ';
  if (PA_HOSTS.has(host) || context.jurisdiction === 'Pennsylvania')
    return 'PA';
  return undefined;
}

// Exact sentences, allowing printed whitespace and the hyphen/en-dash variants observed on
// official PDFs. Do not enable the convention from a passing mention of brackets or italics.
const NY_LEGEND =
  /EXPLANATION\s*[-–—]+\s*Matter in italics\s*\(underscored\) is new;\s*matter in brackets\s*\[\s*\]\s*is old law to be omitted\./gi;
const NJ_LEGEND =
  /EXPLANATION\s*[-–—]+\s*Matter enclosed in bold-faced brackets\s*\[thus\]\s*in the above bill is\s*not enacted and is intended to be omitted in the law\.\s*Matter underlined thus is new matter\.?/gi;

/**
 * Pennsylvania prints no legend on the bill itself. The legislature explains its marks on a
 * separate help page ("Explanation to facilitate reading of legislative bills"): light face
 * brackets "are used only in bills amending an existing law". The final rule:
 * - Whether a measure amends is decided from its TITLE alone: an act titled amending,
 *   reenacting or repealing; a joint resolution proposing a constitutional amendment (or titled
 *   amending); a simple or concurrent resolution that adopts, readopts or amends chamber rules.
 *   Anything else (a new act, an ordinary resolution) keeps its brackets as text.
 * - In an amending measure every bracket outside an underlined run is deleted wording. Balanced
 *   pairs match across paragraphs and quoted headings, but never across the next operative bill
 *   section; such a pair, and any unmatched opening, deletes only to the end of its paragraph and
 *   warns. Lone brackets in an unverified measure warn.
 * - A deletion is verified when it lies in quoted law (after the directive's "to read:" colon in
 *   its bill section). Any other deletion is still made, to honour "removed text is never
 *   presented as current law", but adds a warning.
 */
const PA_COVER = /THE\s+GENERAL\s+ASSEMBLY\s+OF\s+PENNSYLVANIA/;
/** The cover is on page one; mentions deep in a bill's prose do not count. */
const PA_COVER_WINDOW = 8000;
/** The printed line-number gutter may precede a line's own text in the raw layer. */
const PA_GUTTER = /^[ \t]*\d{1,2}[ \t]+/gm;
const PA_TITLE_START =
  /^[ \t]*(AN ACT|A JOINT RESOLUTION|A CONCURRENT RESOLUTION|A RESOLUTION)[ \t]*$/m;
const PA_TITLE_END =
  /The\s+General\s+Assembly\s+of\s+the\s+Commonwealth\s+of\s+Pennsylvania|\bWHEREAS\b|\bRESOLVED\b/i;
const PA_TITLE_AMENDS = /\b(?:amending|re-?enacting|repealing)\b/i;
/** Words that must appear in this order (a linear indexOf chain, never a backtracking regex). */
function inOrder(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  let at = 0;
  for (const word of words) {
    const found = lower.indexOf(word, at);
    if (found < 0) return false;
    at = found + word.length;
  }
  return true;
}
/** Resolutions' titles are short; a longer window is never needed and never scanned. */
const PA_RESOLUTION_TITLE_WINDOW = 4000;
/** "Rules of the House", "permanent rules", "Senate Rule 12": chamber rules, not any rules. */
const PA_CHAMBER_RULES =
  /\brules\s+(?:of|for)\s+the\s+(?:house|senate)\b|\b(?:permanent|temporary|joint)\s+rules\b|\b(?:house|senate)\s+rules?\s+\d/i;
const PA_RULES_VERB = /\b(?:adopting|readopting|amending)\b/i;

/** The title, gutters stripped and lines joined, or undefined when no cover title is found. */
function pennsylvaniaTitle(
  text: string,
): { kind: string; title: string } | undefined {
  const plain = text.replace(PA_GUTTER, '');
  const start = PA_TITLE_START.exec(plain);
  if (!start || start.index > PA_COVER_WINDOW) return undefined;
  const rest = plain.slice(start.index + start[0].length);
  const end = PA_TITLE_END.exec(rest.slice(0, 60000));
  // No verified boundary means no verified title: never scan body text for a decision.
  if (!end) return undefined;
  return {
    kind: (start[1] ?? '').toUpperCase(),
    title: rest.slice(0, end.index).replace(/\s+/g, ' ').trim(),
  };
}

/** A Pennsylvania cover whose measure's title says it amends existing law. */
export function pennsylvaniaAmendingBill(text: string): boolean {
  if (!PA_COVER.test(text.replace(/\s+/g, ' ').slice(0, PA_COVER_WINDOW)))
    return false;
  const found = pennsylvaniaTitle(text);
  if (!found) return false;
  if (found.kind === 'AN ACT') return PA_TITLE_AMENDS.test(found.title);
  const title = found.title.slice(0, PA_RESOLUTION_TITLE_WINDOW);
  if (found.kind === 'A JOINT RESOLUTION')
    return (
      inOrder(title, ['proposing', 'amendment', 'constitution']) ||
      PA_TITLE_AMENDS.test(title)
    );
  // A simple or concurrent resolution is ordinary text unless it adopts, readopts or amends
  // chamber rules, which print their changes in brackets.
  return PA_RULES_VERB.test(title) && PA_CHAMBER_RULES.test(title);
}

/** Words that make a "Section N." line a bill's own directive rather than a quoted heading. */
const PA_OPERATIVE_SECTION =
  /\b(?:amended|added|repealed|re-?enacted|to read|take effect|takes effect|The following)\b/i;
/** A quoted statute's heading ("Section 2. Findings.--"), never a bill section. */
const PA_QUOTED_HEADING = /^.{0,100}\.--/;

/** Lines of a section's opening searched for an operative phrase (a section list can wrap). */
const PA_OPERATIVE_LINES = 8;
/** A directive can list dozens of sections before its colon; this bounds the search. */
const PA_DIRECTIVE_LINES = 60;

export interface PaSection {
  /** Offset of the "Section N." line. */
  start: number;
  /** Offset where quoted law begins: just after the directive's colon ("to read:"). */
  quotedFrom: number;
}

/**
 * A bill's own sections: "Section N." at a line start (any printed gutter is skipped, and N is
 * the number after the word "Section"), N continuing the bill's sequence. A section with no
 * operative phrase ("Any regulations ... are abrogated") is still a boundary, but nothing in it
 * is verified quoted law. After a gap the sequence resyncs on an operative line within three
 * numbers; "Section 36.1." belongs to the current section. The operative look-ahead and the
 * directive colon never borrow words from the following section. A bracket pair never
 * legitimately crosses a boundary, whereas a repealed run can span quoted sections inside one.
 */
export function pennsylvaniaSections(lines: readonly string[]): PaSection[] {
  const sections: PaSection[] = [];
  const offsets: number[] = [];
  let position = 0;
  for (const line of lines) {
    offsets.push(position);
    position += line.length + 1;
  }
  let expected = 1;
  for (const [index, line] of lines.entries()) {
    const match = PA_SECTION_START.exec(line);
    if (!match || PA_QUOTED_HEADING.test(line.slice(match[0].length))) continue;
    const number = Number(match[1]);
    const decimal = match[2] !== undefined;
    // This section's own lines: up to the next "Section N." line, at most PA_DIRECTIVE_LINES.
    let end = index + 1;
    while (
      end < Math.min(lines.length, index + PA_DIRECTIVE_LINES) &&
      !PA_SECTION_START.test(lines[end] ?? '')
    )
      end++;
    const own = lines.slice(index, end);
    const operative = PA_OPERATIVE_SECTION.test(
      own.slice(0, PA_OPERATIVE_LINES).join(' ').replace(/\s+/g, ' '),
    );
    if (decimal) {
      if (number !== expected - 1) continue;
    } else if (number === expected) {
      expected++;
    } else if (operative && number > expected && number <= expected + 3) {
      expected = number + 1;
    } else if (number < expected) {
      // A number already used: a quoted heading shadowing the real section. It still bounds
      // pairs, but expected is unchanged and nothing in it is verified unless it is operative.
    } else continue;
    let quotedFrom = Infinity;
    if (operative) {
      const colon = own.findIndex((text) => text.trimEnd().endsWith(':'));
      if (colon >= 0) quotedFrom = offsets[index + colon + 1] ?? Infinity;
    }
    sections.push({ start: offsets[index] ?? 0, quotedFrom });
  }
  return sections;
}

/** A bill section opening ("Section 2."): a paragraph boundary for bracket recovery. */
const PA_SECTION_START =
  /^[ \t]*(?:\d{1,2}[ \t]+)?Section[ \t]+(\d+)(?:\.(\d+))?[a-z]?\./;

function legendFor(context: ChangeMarkContext): RegExp | undefined {
  const state = changeMarkJurisdiction(context);
  const pattern =
    state === 'NY' ? NY_LEGEND : state === 'NJ' ? NJ_LEGEND : undefined;
  // A PDF/HTML line may wrap between any two words of the exact sentence.
  return pattern
    ? new RegExp(pattern.source.replaceAll(' ', String.raw`\s+`), 'gi')
    : undefined;
}

export function changeMarkConvention(
  text: string,
  context: ChangeMarkContext,
): ChangeMarkConvention {
  if (changeMarkJurisdiction(context) === 'PA')
    return pennsylvaniaAmendingBill(text) ? 'bracket-underline' : 'default';
  const legend = legendFor(context);
  return legend && new RegExp(legend.source, 'i').test(text)
    ? 'bracket-underline'
    : 'default';
}

/** Under a verified legend, even a bracketed citation is old law. Only editorial labels
 * are literal. The NJ fixture prints [Second Reprint] on its cover, outside the law text.
 * Explicit strike markup still wins, including on an otherwise literal label.
 */
function literalBracket(body: string, lineBefore: string): boolean {
  const text = body.replace(/\s+/g, ' ').trim();
  return (
    /^(?:sic|reserved)\.?$/i.test(text) ||
    /^(?:First|Second|Third|Fourth|Fifth) Reprint$/i.test(text) ||
    // NJ running header "S1000 [1R] SPONSOR": 1R/2R is the reprint number, not law text.
    (/^\d{1,2}R$/i.test(text) && /^\s*[SA]\d{1,5}\s+$/.test(lineBefore))
  );
}

/** NY prints this cover boilerplate underlined/italic even when it amends existing law. */
export function newYorkEnactingClause(
  text: string,
): { start: number; end: number } | undefined {
  const match =
    /^[ \t]*The\s+People\s+of\s+the\s+State\s+of\s+New\s+York,\s*represented\s+in\s+Senate\s+and\s+Assem(?:-\s*)?bly,\s*do\s+enact\s+as\s+follows:/m.exec(
      text.slice(0, 2000),
    );
  const firstSection =
    /^[ \t]*(?:Section\s+\d|§\s*\d)/m.exec(text)?.index ?? text.length;
  return match && match.index < firstSection
    ? { start: match.index, end: match.index + match[0].length }
    : undefined;
}

/** Recovery boundaries apply only to unmatched openings, never to balanced deletions. */
function recoveryBoundaries(lines: readonly SourceLine[]): number[] {
  const boundaries: number[] = [];
  let offset = 0;
  let previousPage: number | undefined;
  for (const line of lines) {
    if (
      !line.text.trim() ||
      line.text.includes('\f') ||
      /^\s*(?:(?:Section|Sec\.)\s+\d+(?:[.:-]|\s)|§\s*\d+)/i.test(line.text) ||
      (previousPage !== undefined &&
        line.page !== undefined &&
        line.page !== previousPage)
    )
      boundaries.push(offset);
    previousPage = line.page;
    offset += line.text.length + 1;
  }
  return boundaries;
}

/**
 * Warnings added when a New York or New Jersey bill has brackets but no change legend. Exported
 * so callers (the MCP server) can recognise them by identity instead of matching prose.
 */
export const LEGEND_NOT_FOUND_WARNINGS = {
  NY: "This New York bill's change legend was not found, so bracketed wording could not be marked as removed.",
  NJ: "This New Jersey bill's change legend was not found, so bracketed wording could not be marked as removed.",
  PA: 'This Pennsylvania document is not an amending measure, or its title could not be verified, so bracketed wording could not be marked as removed.',
} as const;

export function isLegendNotFoundWarning(warning: string): boolean {
  return (Object.values(LEGEND_NOT_FOUND_WARNINGS) as string[]).includes(
    warning,
  );
}

/**
 * The NJ reprint footnote: the "Matter enclosed in superscript numerals" line followed by
 * entries that start with "Senate"/"Assembly" and end with a dated period, wrapping lines.
 */
function superscriptFootnotes(
  lines: readonly SourceLine[],
): { start: number; end: number }[] {
  const notes: { start: number; end: number }[] = [];
  let offset = 0;
  let open: { start: number } | undefined;
  let inEntry = false;
  let end = 0;
  const close = (): void => {
    if (open) notes.push({ start: open.start, end });
    open = undefined;
    inEntry = false;
  };
  for (const line of lines) {
    const text = line.text.trim();
    const lineEnd = offset + line.text.length + 1;
    if (
      /^Matter enclosed in superscript numerals has been adopted as follows:?$/i.test(
        text,
      )
    ) {
      close();
      open = { start: offset };
      end = lineEnd;
    } else if (open) {
      if (inEntry || /^(?:Senate|Assembly)\b/.test(text)) {
        inEntry = !/\d{4}\.$/.test(text);
        end = lineEnd;
      } else close();
    }
    offset = lineEnd;
  }
  close();
  return notes;
}

/** The line that ends a Pennsylvania cover and starts the measure's own title. */
const PA_TITLE_LINE = /^\s*(?:AN ACT|A (?:JOINT |CONCURRENT )?RESOLUTION)\s*$/;
/** The cover is the first page; a title line is looked for only near the top. */
const PA_COVER_LINES = 60;
/** Only a print that was amended in a chamber lists the earlier printer's numbers. */
const PA_AMENDED_PRINT = /PRIOR\s+PRINTER'?S\s+NOS?\./;
const CAPS_WORD = /^[A-Z][A-Z0-9'’.,;:()§"&/-]*$/;
const SINGLE_CAPS_WORD = /^[AI]$/;

/**
 * Words printed in CAPITAL LETTERS by an amendment. The legislature's rule: capitals "indicate
 * that the matter in capital letters did not appear in the original print of the bill, but was
 * inserted into the bill by amendment". Amended bills that change existing law also underline
 * such text (read as an insertion by the geometry), but an amended new act has no underlining,
 * so its added words show only as capitals. To avoid reading acronyms and headings as
 * insertions, only a run of two or more capitalised words counts, and only after the title.
 */
function markCapitalLetterInsertions(
  lines: readonly { text: string; statuses: SpanStatus[]; caps: boolean[] }[],
  from: number,
): void {
  interface Word {
    line: number;
    start: number;
    end: number;
    caps: boolean;
  }
  const flush = (run: Word[]): void => {
    while (run.length && !run[run.length - 1]?.caps) run.pop();
    if (run.filter((word) => word.caps).length < 2) return;
    for (const [at, word] of run.entries()) {
      const line = lines[word.line];
      // Spaces between two words of the run are part of it, so the insertion is one span.
      const next = run[at + 1];
      const end = next?.line === word.line ? next.start : word.end;
      for (let char = word.start; char < end; char++)
        if (line?.statuses[char] === 'unchanged') {
          line.statuses[char] = 'inserted';
          line.caps[char] = true;
        }
    }
  };
  let run: Word[] = [];
  for (const [index, line] of lines.entries()) {
    if (index < from) continue;
    for (const match of line.text.matchAll(/\S+/g)) {
      const token = match[0];
      const caps = CAPS_WORD.test(token) && /[A-Z]{2}/.test(token);
      const connector = !caps && SINGLE_CAPS_WORD.test(token);
      if (caps || (connector && run.length > 0))
        run.push({
          line: index,
          start: match.index,
          end: match.index + token.length,
          caps,
        });
      else {
        flush(run);
        run = [];
      }
    }
    // A blank line ends a paragraph; a wrapped line does not end the run.
    if (!line.text.trim()) {
      flush(run);
      run = [];
    }
  }
  flush(run);
}

/**
 * Pennsylvania-only repairs before the text is read:
 * - Amended prints put a "<--" pointer in the margin beside each changed line. It is the
 *   legislature's finger pointing at the change, not words of the bill, so it is dropped
 *   (in new acts too, where the pointers also appear).
 * - The cover prints "PRINTER'S NO. 4082" and "PRIOR PRINTER'S NOS." over a rule, which reads as
 *   underlined (inserted) text. Nothing above the title line is law, so it stays unchanged.
 * - In an amended print, capital-letter runs are the amendment's insertions.
 */
function readPennsylvaniaPrint<T extends SourceLine>(
  lines: readonly T[],
): { lines: (T & SourceLine)[]; caps: boolean[][] } {
  const titleAt = lines
    .slice(0, PA_COVER_LINES)
    .findIndex((line) => PA_TITLE_LINE.test(line.text));
  const cleaned: {
    line: T;
    text: string;
    statuses: SpanStatus[];
    caps: boolean[];
  }[] = [];
  for (const [index, line] of lines.entries()) {
    const cover = index < titleAt;
    let text = '';
    const statuses: SpanStatus[] = [];
    for (let at = 0; at < line.text.length; at++) {
      if (line.text.startsWith('<--', at)) {
        at += 2;
        continue;
      }
      text += line.text.charAt(at);
      statuses.push(cover ? 'unchanged' : (line.statuses?.[at] ?? 'unchanged'));
    }
    // Blank lines stay: they bound an unclosed bracket's recovery. Only a line the pointer
    // removal emptied is dropped.
    if (text.trim() || !line.text.trim())
      cleaned.push({ line, text, statuses, caps: [] });
  }
  const coverText = lines
    .slice(0, Math.max(titleAt, 0))
    .map((line) => line.text)
    .join('\n');
  if (titleAt >= 0 && PA_AMENDED_PRINT.test(coverText))
    markCapitalLetterInsertions(
      cleaned,
      cleaned.findIndex((entry) => PA_TITLE_LINE.test(entry.text)) + 1,
    );
  return {
    lines: cleaned.map(({ line, text, statuses }) => ({
      ...line,
      text,
      statuses,
    })),
    caps: cleaned.map((entry) => entry.caps),
  };
}

/**
 * One document-wide pass, before section detection. Joining lines keeps state across HTML
 * elements and PDF pages; splitting back preserves every printed coordinate. Legend text is
 * removed before scanning, including a footer inside a deletion that spans the page break.
 */
export function applyChangeMarks<T extends SourceLine>(
  printedLines: readonly T[],
  context: ChangeMarkContext,
  /** PDF layout may already have removed a repeated legend footer. */
  legendText?: string,
): {
  lines: (T & SourceLine)[];
  convention: ChangeMarkConvention;
  warnings: string[];
} {
  const jurisdiction = changeMarkJurisdiction(context);
  if (!jurisdiction)
    return { lines: [...printedLines], convention: 'default', warnings: [] };
  const pa =
    jurisdiction === 'PA' ? readPennsylvaniaPrint(printedLines) : undefined;
  const lines = pa?.lines ?? printedLines;
  /** Characters inserted only by the capital-letters rule, not by a drawn underline. */
  const capsMask: boolean[] = [];
  for (const [index, line] of lines.entries()) {
    for (let at = 0; at < line.text.length; at++)
      capsMask.push(pa?.caps[index]?.[at] === true);
    capsMask.push(false);
  }
  const text = lines.map((line) => line.text).join('\n');
  // Pennsylvania: the title is read with struck-through words removed, as metadata does.
  const gateText =
    jurisdiction === 'PA'
      ? lines
          .map((line) =>
            line.text
              .split('')
              .filter((_char, at) => line.statuses?.[at] !== 'deleted')
              .join(''),
          )
          .join('\n')
      : (legendText ?? text);
  const convention = changeMarkConvention(gateText, context);
  if (convention === 'default')
    return {
      lines: [...lines],
      convention,
      warnings:
        // Fail safe: brackets that could not be classified are never silently current law.
        text.includes('[') || text.includes(']')
          ? [LEGEND_NOT_FOUND_WARNINGS[jurisdiction]]
          : [],
    };
  // Pennsylvania: brackets pair and recover within a paragraph (blank line or bill section).
  const paragraphStarts = new Set<number>();
  const paSections =
    jurisdiction === 'PA' ? pennsylvaniaSections(lines.map((l) => l.text)) : [];
  let latestSection = -1;
  // A measure with no bill sections (a rules resolution) quotes law after the first colon
  // that ends a line following its RESOLVED clause.
  let resolvedQuotedFrom = Infinity;
  if (jurisdiction === 'PA' && paSections.length === 0) {
    let position = 0;
    let resolved = false;
    for (const line of lines) {
      resolved ||= /^[ \t]*(?:\d{1,2}[ \t]+)?RESOLVED\b/.test(line.text);
      position += line.text.length + 1;
      if (resolved && line.text.trimEnd().endsWith(':')) {
        resolvedQuotedFrom = position;
        break;
      }
    }
  }
  const paQuoted = (start: number, section: PaSection | undefined): boolean =>
    start >= (section ? section.quotedFrom : resolvedQuotedFrom);
  /** Unmatched openings (including pairs that crossed a bill section), recovered below. */
  const unmatchedOpens: number[] = [];
  if (jurisdiction === 'PA') {
    let position = 0;
    for (const line of lines) {
      if (!line.text.trim() || PA_SECTION_START.test(line.text))
        paragraphStarts.add(position);
      position += line.text.length + 1;
    }
  }
  const statuses: SpanStatus[] = [];
  for (const line of lines) {
    for (let at = 0; at < line.text.length; at++)
      statuses.push(line.statuses?.[at] ?? 'unchanged');
    statuses.push('unchanged');
  }
  if (jurisdiction === 'NY') {
    const clause = newYorkEnactingClause(text);
    if (clause)
      for (let at = clause.start; at < clause.end; at++)
        if (statuses[at] === 'inserted') statuses[at] = 'unchanged';
  }
  const removed = new Uint8Array(text.length);
  // Pennsylvania has no printed legend sentence to set aside; its gate was the cover itself.
  const legend = legendFor(context);
  if (!legend && jurisdiction !== 'PA')
    return { lines: [...lines], convention: 'default', warnings: [] };
  if (legend)
    for (const match of text.matchAll(new RegExp(legend.source, 'gi')))
      removed.fill(1, match.index, match.index + match[0].length);
  if (jurisdiction === 'NJ') {
    // Reprints print "Matter enclosed in superscript numerals has been adopted as follows:"
    // and the committee-amendment list at the foot of a page, which can fall mid-sentence.
    for (const note of superscriptFootnotes(lines))
      removed.fill(1, note.start, note.end);
  }
  const warnings: string[] = [];
  const stack: number[] = [];
  const pairs: { start: number; end: number }[] = [];
  let unmatchedClosing = false;
  let paUnclosed = false;
  let outsideQuoted = false;
  let overwroteInserted = false;
  let verifiedSection = -1;
  const coversDrawnInsertion = (start: number, end: number): boolean => {
    for (let at = start; at < end; at++)
      if (statuses[at] === 'inserted' && !capsMask[at]) return true;
    return false;
  };
  const mark = (start: number, end: number): void => {
    for (let at = start; at < end; at++)
      if (!removed[at]) statuses[at] = 'deleted';
  };
  for (let at = 0; at < text.length; at++) {
    if (removed[at]) continue;
    // Verified inserted words (Pennsylvania) may contain literal brackets, e.g. a form's "[optional]".
    if (jurisdiction === 'PA') {
      if (statuses[at] === 'inserted') continue;
    }
    while ((paSections[latestSection + 1]?.start ?? Infinity) <= at)
      latestSection++;
    if (text[at] === '[') stack.push(at);
    else if (text[at] === ']') {
      const start = stack.pop();
      if (start === undefined) {
        unmatchedClosing = true;
      } else if (
        jurisdiction === 'PA' &&
        (paSections[latestSection]?.start ?? -1) > start
      ) {
        // A pair that crosses into the next operative bill section cannot be legitimate:
        // read its opening as unmatched (bounded to its paragraph) and warn.
        unmatchedOpens.push(start);
        unmatchedClosing = true;
      } else pairs.push({ start, end: at + 1 });
    }
  }
  // Process enclosing pairs first. Balanced deletions inside an unmatched opening still
  // apply independently, but nested pairs never rescan/re-mark a large enclosing deletion.
  let deletedThrough = 0;
  for (const { start, end } of pairs.sort((a, b) => a.start - b.start)) {
    if (
      start < deletedThrough ||
      // PA keeps no literal exemptions: "[Reserved]" or "[sic]" there is old law to omit.
      (jurisdiction !== 'PA' &&
        literalBracket(
          text.slice(start + 1, end - 1),
          text.slice(text.lastIndexOf('\n', start) + 1, start),
        ))
    )
      continue;
    if (jurisdiction === 'PA' && coversDrawnInsertion(start, end))
      overwroteInserted = true;
    mark(start, end);
    deletedThrough = end;
    if (jurisdiction === 'PA') {
      while ((paSections[verifiedSection + 1]?.start ?? Infinity) <= start)
        verifiedSection++;
      if (!paQuoted(start, paSections[verifiedSection])) outsideQuoted = true;
    }
    // PDF/HTML superscripts are removed before this pass. Matching plain-text committee
    // digits outside brackets are not law text.
    if (jurisdiction === 'NJ') {
      const left = text[start - 1];
      if (left && /[¹²³⁴⁵⁶⁷⁸⁹0-9]/.test(left) && text[end] === left) {
        mark(start - 1, start);
        mark(end, end + 1);
      }
    }
  }
  if (unmatchedClosing)
    warnings.push(
      'An unmatched closing amendment bracket was found; check the original document.',
    );
  if (jurisdiction === 'PA' && (stack.length || unmatchedOpens.length)) {
    // Balanced pairs were matched across paragraphs and quoted headings above (a repealed run
    // can enclose several sections). Only an unmatched opening is bounded: it deletes to the
    // end of its own paragraph. One advancing cursor keeps this linear.
    // Blank lines, bill sections, quoted headings and page breaks all end a recovery.
    const starts = [
      ...new Set([...paragraphStarts, ...recoveryBoundaries(lines)]),
    ].sort((a, b) => a - b);
    let cursor = 0;
    let recoveredThrough = 0;
    for (const start of [...stack, ...unmatchedOpens].sort((a, b) => a - b)) {
      if (start < recoveredThrough) continue;
      while (cursor < starts.length && (starts[cursor] ?? 0) <= start) cursor++;
      recoveredThrough = starts[cursor] ?? text.length;
      mark(start, recoveredThrough);
    }
    stack.length = 0;
    paUnclosed = true;
  }
  if (overwroteInserted)
    warnings.push(
      'Underlined wording inside a bracketed deletion was treated as removed; check the original document.',
    );
  if (outsideQuoted)
    warnings.push(
      'Bracketed wording outside amended text was treated as removed; check the original document.',
    );
  if (paUnclosed)
    warnings.push(
      'An amendment bracket was not closed. Text is treated as deleted only to the end of its paragraph; check the original document.',
    );
  if (stack.length) {
    const boundaries = recoveryBoundaries(lines);
    let boundaryIndex = 0;
    let recoveredThrough = 0;
    for (const start of stack) {
      if (start < recoveredThrough) continue;
      while ((boundaries[boundaryIndex] ?? text.length) <= start)
        boundaryIndex++;
      recoveredThrough = boundaries[boundaryIndex] ?? text.length;
      mark(start, recoveredThrough);
    }
    warnings.push(
      'An amendment bracket was not closed. Text is treated as deleted only up to the next section, page or paragraph boundary (or the document end); check the original document.',
    );
  }
  let offset = 0;
  const result: (T & SourceLine)[] = [];
  for (const line of lines) {
    let kept = '';
    const keptStatuses: SpanStatus[] = [];
    for (let at = 0; at < line.text.length; at++) {
      if (!removed[offset + at]) {
        kept += line.text.charAt(at);
        keptStatuses.push(statuses[offset + at] ?? 'unchanged');
      }
    }
    offset += line.text.length + 1;
    if (kept.trim())
      result.push({ ...line, text: kept, statuses: keptStatuses });
  }
  return { lines: result, convention, warnings };
}
