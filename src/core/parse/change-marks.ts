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

/**
 * Narrow literal exceptions: editorial [sic]/[Reserved], explicit statute/reporter citations,
 * and a numeric citation introduced by "see"/"citation". Bare numbers remain deletions:
 * changing [3] to 4 is common legislative drafting. Explicit strike markup always wins.
 * No plain-text heuristic can disambiguate every possible literal square bracket.
 */
function literalBracket(body: string, before: string): boolean {
  const text = body.replace(/\s+/g, ' ').trim();
  return (
    /^(?:sic|reserved)\.?$/i.test(text) ||
    /^(?:(?:First|Second|Third|Fourth|Fifth) Reprint|\d+R)$/i.test(text) ||
    /^(?:\d+\s+U\.?\s*S\.?\s*C\.?\s+\d+[a-z]?(?:[-.]\d+[a-z]?)*(?:\([a-z0-9]+\))*|\d+\s+(?:N\.Y\.(?:S\.)?|N\.J\.|A\.|F\.|S\.Ct\.)(?:\d+d)?\s+\d+(?:[-–,]\s*\d+)*(?:\s+\(\d{4}\))?|(?:see\s+)?(?:section|§)\s*\d+[a-z]?(?:-[a-z0-9]+)*(?:\([a-z0-9]+\))*)$/i.test(
      text,
    ) ||
    (/^\d+(?:[ ,–-]\d+)*$/.test(text) && /\b(?:see|citation)\s*$/i.test(before))
  );
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
  if (!changeMarkJurisdiction(context))
    return { lines: [...lines], convention: 'default', warnings: [] };
  const text = lines.map((line) => line.text).join('\n');
  const convention = changeMarkConvention(legendText ?? text, context);
  if (convention === 'default')
    return { lines: [...lines], convention, warnings: [] };
  const statuses: SpanStatus[] = [];
  for (const line of lines) {
    for (let at = 0; at < line.text.length; at++)
      statuses.push(line.statuses?.[at] ?? 'unchanged');
    statuses.push('unchanged');
  }
  const removed = new Uint8Array(text.length);
  const legend = legendFor(context);
  if (!legend)
    return { lines: [...lines], convention: 'default', warnings: [] };
  for (const match of text.matchAll(new RegExp(legend.source, 'gi')))
    removed.fill(1, match.index, match.index + match[0].length);
  const warnings: string[] = [];
  const stack: number[] = [];
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
      } else if (
        stack.length === 0 &&
        !literalBracket(
          text.slice(start + 1, at),
          text.slice(Math.max(0, start - 20), start),
        )
      ) {
        mark(start, at + 1);
        // Plain-text committee bracket notation. PDF/HTML superscripts are removed as
        // typography before this pass. Matching digits outside brackets are not law text.
        if (changeMarkJurisdiction(context) === 'NJ') {
          const left = /[¹²³⁴⁵⁶⁷⁸⁹0-9]$/.exec(
            text.slice(Math.max(0, start - 1), start),
          )?.[0];
          if (left && text[at + 1] === left) {
            mark(start - 1, start);
            mark(at + 1, at + 2);
          }
        }
      }
    }
  }
  if (unmatchedClosing)
    warnings.push(
      'An unmatched closing amendment bracket was found; check the original document.',
    );
  if (stack.length) {
    mark(stack[0] ?? 0, text.length);
    warnings.push(
      'An amendment bracket was not closed. Text from that bracket onward is treated as deleted; check the original document.',
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
