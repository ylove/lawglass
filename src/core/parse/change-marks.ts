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
 * brackets "are used only in bills amending an existing law" and enclose old law to be omitted.
 * So the gate is the printed cover plus the bill saying it amends something; a standalone act
 * or resolution, where a bracket is ordinary punctuation, is left alone.
 */
const PA_COVER = /THE\s+GENERAL\s+ASSEMBLY\s+OF\s+PENNSYLVANIA/;
/** The cover is on page one; mentions deep in a bill's prose do not count. */
const PA_COVER_WINDOW = 3000;
/** The printed line-number gutter may precede a line's own text in the raw layer. */
const GUTTER = String.raw`^[ \t]*(?:\d{1,2}[ \t]+)?`;
/** A bill's own section opener ("Section 2."); only the next number in sequence counts. */
const PA_SECTION_LINE = new RegExp(`${GUTTER}Section[ \\t]+(\\d+)[a-z]?\\.`);
/** A joint resolution's directive ("That Article III be amended ..."). */
const PA_JOINT_LINE = new RegExp(`${GUTTER}That[ \\t]+(?:Article|Section)\\b`);
/**
 * What makes an existing-law block: the directive says the provision "is amended" (or "is
 * reenacted and amended", "is repealed", "be amended") and does not merely add to it.
 * "amended by adding ... to read" is new law: underline marks it, and brackets stay literal.
 */
const PA_REPLACING =
  /\b(?:(?:is|are) (?:hereby )?(?:re-?enacted and )?amended|be amended|(?:is|are) repealed)\b(?! by adding)/i;
/** How a bill's own section opens: naming the law it changes, or its own effect. */
const PA_DIRECTIVE_OPENING =
  /^\s*(?:Sections?|Titles?|Chapters?|Articles?|Subchapters?|Parts?|The\b|This act|Subsections?|Paragraphs?|A new|Repeal|\d)/;
/** Verbs of an operative directive, as opposed to quoted statute text. */
const PA_OPERATIVE = /\b(?:amended|repealed|re-?enacted|take effect)\b/i;
/** A directive clause ends at its colon ("to read:"); this many lines is the safety bound. */
const PA_CLAUSE_LINES = 12;

/**
 * Line ranges of Pennsylvania text that quote EXISTING law being replaced or repealed: the
 * lines after an operative directive whose clause is "... is amended to read:" (or
 * "reenacted and amended", "repealed", or a joint resolution's "be amended"), up to the next
 * directive. Titles, recitals, resolving clauses and new sections are never inside one, so
 * a bracket there is ordinary text. Clauses are read across wrapped lines and the periods in
 * citations such as "(P.L.1, No.2)", because the clause ends at its colon, not at a period.
 */
export function pennsylvaniaAmendedBlocks(
  lines: readonly string[],
): { start: number; end: number }[] {
  const starts: { line: number; clauseEnd: number; replacing: boolean }[] = [];
  let expected = 1;
  for (const [index, line] of lines.entries()) {
    const section = PA_SECTION_LINE.exec(line);
    const joint = !section && PA_JOINT_LINE.test(line);
    if (section ? Number(section[1]) !== expected : !joint) continue;
    // A quoted statute's own "Section 2. Findings and policy.--" is a heading, not a directive:
    // a bill's directive opens with a reference to what it changes, or with "This act".
    if (section) {
      const rest = line.slice(section.index + section[0].length);
      const near = [rest, lines[index + 1] ?? '', lines[index + 2] ?? '']
        .join(' ')
        .replace(/\s+/g, ' ');
      if (
        !PA_DIRECTIVE_OPENING.test(rest) &&
        !(!/^.{0,100}\.--/.test(rest) && PA_OPERATIVE.test(near))
      )
        continue;
    }
    if (section) expected++;
    let clauseEnd = index;
    let clause = '';
    for (
      ;
      clauseEnd < Math.min(lines.length, index + PA_CLAUSE_LINES);
      clauseEnd++
    ) {
      clause += ` ${lines[clauseEnd] ?? ''}`;
      if ((lines[clauseEnd] ?? '').trimEnd().endsWith(':')) break;
    }
    starts.push({
      line: index,
      clauseEnd,
      replacing: PA_REPLACING.test(clause.replace(/\s+/g, ' ')),
    });
  }
  const blocks: { start: number; end: number }[] = [];
  for (const [at, directive] of starts.entries()) {
    if (!directive.replacing) continue;
    blocks.push({
      start: directive.clauseEnd + 1,
      end: starts[at + 1]?.line ?? lines.length,
    });
  }
  return blocks;
}

/** A Pennsylvania cover whose bill has at least one block of replaced or repealed law. */
export function pennsylvaniaAmendingBill(text: string): boolean {
  return (
    PA_COVER.test(text.replace(/\s+/g, ' ').slice(0, PA_COVER_WINDOW)) &&
    pennsylvaniaAmendedBlocks(text.split('\n')).length > 0
  );
}

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
  PA: "This Pennsylvania document's printed bill cover was not found, so bracketed wording could not be marked as removed.",
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
  lines: readonly { text: string; statuses: SpanStatus[] }[],
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
        if (line?.statuses[char] === 'unchanged')
          line.statuses[char] = 'inserted';
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
): (T & SourceLine)[] {
  const titleAt = lines
    .slice(0, PA_COVER_LINES)
    .findIndex((line) => PA_TITLE_LINE.test(line.text));
  const cleaned: { line: T; text: string; statuses: SpanStatus[] }[] = [];
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
      cleaned.push({ line, text, statuses });
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
  return cleaned.map(({ line, text, statuses }) => ({
    ...line,
    text,
    statuses,
  }));
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
  const lines =
    jurisdiction === 'PA' ? readPennsylvaniaPrint(printedLines) : printedLines;
  const text = lines.map((line) => line.text).join('\n');
  const convention = changeMarkConvention(legendText ?? text, context);
  if (convention === 'default')
    return {
      lines: [...lines],
      convention,
      warnings:
        // Fail safe: brackets that could not be classified are never silently current law.
        text.includes('[') ? [LEGEND_NOT_FOUND_WARNINGS[jurisdiction]] : [],
    };
  // Pennsylvania: only text quoting replaced or repealed law can hold a deletion.
  const inScope = new Uint8Array(text.length);
  if (jurisdiction === 'PA') {
    const starts: number[] = [];
    let position = 0;
    for (const line of lines) {
      starts.push(position);
      position += line.text.length + 1;
    }
    for (const block of pennsylvaniaAmendedBlocks(lines.map((l) => l.text)))
      inScope.fill(
        1,
        starts[block.start] ?? text.length,
        starts[block.end] ?? text.length,
      );
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
  const mark = (start: number, end: number): void => {
    for (let at = start; at < end; at++)
      if (!removed[at]) statuses[at] = 'deleted';
  };
  for (let at = 0; at < text.length; at++) {
    if (removed[at]) continue;
    // Verified inserted words (Pennsylvania) may contain literal brackets, e.g. a form's "[optional]".
    if (jurisdiction === 'PA' && (!inScope[at] || statuses[at] === 'inserted'))
      continue;
    if (text[at] === '[') stack.push(at);
    else if (text[at] === ']') {
      const start = stack.pop();
      if (start === undefined) {
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
      literalBracket(
        text.slice(start + 1, end - 1),
        text.slice(text.lastIndexOf('\n', start) + 1, start),
      )
    )
      continue;
    mark(start, end);
    deletedThrough = end;
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
