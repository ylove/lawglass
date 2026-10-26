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

export function changeMarkJurisdiction(
  context: ChangeMarkContext,
): 'NY' | 'NJ' | undefined {
  const host = new URL(context.sourceUrl).hostname;
  if (NY_HOSTS.has(host) || context.jurisdiction === 'New York') return 'NY';
  if (NJ_HOSTS.has(host) || context.jurisdiction === 'New Jersey') return 'NJ';
  return undefined;
}

// Exact sentences, allowing printed whitespace and the hyphen/en-dash variants observed on
// official PDFs. Do not enable the convention from a passing mention of brackets or italics.
const NY_LEGEND =
  /EXPLANATION\s*[-–—]+\s*Matter in italics\s*\(underscored\) is new;\s*matter in brackets\s*\[\s*\]\s*is old law to be omitted\./gi;
const NJ_LEGEND =
  /EXPLANATION\s*[-–—]+\s*Matter enclosed in bold-faced brackets\s*\[thus\]\s*in the above bill is\s*not enacted and is intended to be omitted in the law\.\s*Matter underlined thus is new matter\.?/gi;

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
  const legend = legendFor(context);
  return legend && new RegExp(legend.source, 'i').test(text)
    ? 'bracket-underline'
    : 'default';
}

/** Under a verified legend, even a bracketed citation is old law. Only editorial labels
 * are literal. The NJ fixture prints [Second Reprint] on its cover, outside the law text.
 * Explicit strike markup still wins, including on an otherwise literal label.
 */
function literalBracket(body: string): boolean {
  const text = body.replace(/\s+/g, ' ').trim();
  return (
    /^(?:sic|reserved)\.?$/i.test(text) ||
    /^(?:First|Second|Third|Fourth|Fifth) Reprint$/i.test(text)
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
 * One document-wide pass, before section detection. Joining lines keeps state across HTML
 * elements and PDF pages; splitting back preserves every printed coordinate. Legend text is
 * removed before scanning, including a footer inside a deletion that spans the page break.
 */
export function applyChangeMarks<T extends SourceLine>(
  lines: readonly T[],
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
    return { lines: [...lines], convention: 'default', warnings: [] };
  const text = lines.map((line) => line.text).join('\n');
  const convention = changeMarkConvention(legendText ?? text, context);
  if (convention === 'default')
    return {
      lines: [...lines],
      convention,
      warnings: text.includes('[')
        ? [
            `This ${jurisdiction === 'NY' ? 'New York' : 'New Jersey'} bill's change legend was not found, so bracketed wording could not be marked as removed.`,
          ]
        : [],
    };
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
  const legend = legendFor(context);
  if (!legend)
    return { lines: [...lines], convention: 'default', warnings: [] };
  for (const match of text.matchAll(new RegExp(legend.source, 'gi')))
    removed.fill(1, match.index, match.index + match[0].length);
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
      literalBracket(text.slice(start + 1, end - 1))
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
