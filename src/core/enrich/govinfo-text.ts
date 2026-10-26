import { load } from 'cheerio';

/**
 * Plain text from a GovInfo U.S. Code page (`.../content/pkg/USCODE-.../html/...htm`), and the
 * definition of one term inside it.
 *
 * The page is simple, flat HTML: one `<h3 class="section-head">`, then headings and body
 * paragraphs whose class carries the nesting (`paragraph-head`, `statutory-body-2em`). Notes
 * and amendment history follow the statute proper and are left out. The page is untrusted
 * text like the bill itself: nothing here interprets it, it is only cut and shortened.
 */

/** One printed line of the statute. */
export interface StatuteLine {
  kind: 'head' | 'body';
  /** Head lines: 0 for the section, rising with each nesting level. Body lines: indent in em. */
  level: number;
  text: string;
}

export interface UsCodeSection {
  /** "§6809. Definitions" as printed. */
  heading: string | undefined;
  lines: StatuteLine[];
}

/** A block cut for one term. */
export interface TermBlock {
  term: string;
  text: string;
}

/** Characters kept for one term's definition, and for a whole section when no term is found. */
export const MAX_TERM_CHARS = 2500;
export const MAX_SECTION_CHARS = 3000;

const HEAD_LEVELS: Record<string, number> = {
  section: 0,
  subsection: 1,
  paragraph: 2,
  subparagraph: 3,
  clause: 4,
  subclause: 5,
  item: 6,
  subitem: 7,
};

/** Text of a node as a reader sees it: no markup, entities decoded, one space between words. */
function plain(text: string): string {
  // The parser has already removed markup, so what is left is text. Angle brackets in it
  // are dropped anyway: nothing downstream wants them, and none can reach a prompt as a tag.
  return text.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function lineKind(
  cls: string,
): Pick<StatuteLine, 'kind' | 'level'> | undefined {
  const head = /\b([a-z]+)-head\b/.exec(cls);
  if (head) return { kind: 'head', level: HEAD_LEVELS[head[1] ?? ''] ?? 8 };
  if (/\bstatutory-body/.test(cls)) {
    const em = /(\d)em\b/.exec(cls);
    return { kind: 'body', level: em ? Number(em[1]) : 0 };
  }
  // Notes, footnotes, source credit: not the statute.
  return /\b(?:note|source-credit|footnote)/.test(cls)
    ? undefined
    : { kind: 'body', level: 0 };
}

/** Reads the section heading and the statute's lines out of a GovInfo page. */
export function parseUsCodePage(html: string): UsCodeSection {
  const start = html.indexOf('<!-- field-start:statute -->');
  const end = html.indexOf('<!-- field-end:statute -->');
  // A real parser, in one linear pass: the page is untrusted and up to a few megabytes.
  const $ = load(html);
  const headText = $('h3.section-head').first().text();
  const heading = plain(headText) || undefined;
  // A page without the statute markers (a trimmed copy) is read from the heading on.
  const region =
    start === -1
      ? $
      : load(html.slice(start, end !== -1 && end > start ? end : undefined));
  const lines: StatuteLine[] = [];
  region('h1, h2, h3, h4, h5, h6, p').each((_i, element) => {
    const text = plain(region(element).text());
    if (!text) return;
    const kind = lineKind(region(element).attr('class') ?? '');
    if (!kind) return;
    // The section's own heading is printed again inside the region on some pages.
    if (kind.kind === 'head' && kind.level === 0) return;
    lines.push({ ...kind, text });
  });
  return { heading, lines };
}

/** `text` without trailing characters from `chars`. A loop: a `+$` regex is quadratic on long runs. */
function trimEndChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

const normalize = (text: string): string =>
  trimEndChars(
    text
      .toLowerCase()
      .replace(/[“”„‟"]/g, '"')
      .replace(/[‘’‛']/g, "'")
      .replace(/\s+/g, ' '),
    ' .,:;—–-',
  ).trim();

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "(3) Financial institution" -> "financial institution". */
function headTerm(text: string): string {
  return normalize(text.replace(/^(?:\([A-Za-z0-9]+\)\s*)+/, ''));
}

function defines(line: StatuteLine, lookup: string): boolean {
  const term = escapeRegExp(normalize(lookup));
  const text = normalize(line.text);
  return new RegExp(
    `(?:^|\\bthe\\s+terms?\\s+)"${term}"|\\bthe\\s+term\\s+${term}\\s+(?:means|includes|has|refers)\\b`,
  ).test(text);
}

/** The lines from `at` to just before the next line that is not part of it. */
function blockFrom(lines: readonly StatuteLine[], at: number): StatuteLine[] {
  const first = lines[at];
  if (!first) return [];
  const block = [first];
  for (const line of lines.slice(at + 1)) {
    const ends =
      first.kind === 'head'
        ? line.kind === 'head' && line.level <= first.level
        : line.kind === 'head' || line.level <= first.level;
    if (ends) break;
    block.push(line);
  }
  return block;
}

/**
 * The line that opens the part labeled `(designator)`. A printed heading (`subsection-head`,
 * `paragraph-head`, ...) beats body text that merely starts with the same label, because
 * lowercase-roman clauses collide with lettered subsections: "(v)" is also the fifth clause of
 * a list, and in 42 U.S.C. 1395x the first "(v) meets such other conditions" is not subsection
 * (v). Among headings the shallowest wins, then the first on the page.
 */
function labeledLine(
  lines: readonly StatuteLine[],
  designator: string,
): number {
  const label = `(${designator})`;
  let best = -1;
  lines.forEach((line, i) => {
    if (line.text !== label && !line.text.startsWith(`${label} `)) return;
    const current = best === -1 ? undefined : lines[best];
    if (current === undefined) {
      best = i;
      return;
    }
    const better =
      line.kind === 'head' &&
      (current.kind !== 'head' || line.level < current.level);
    if (better) best = i;
  });
  return best;
}

/**
 * The subsection a bill cites ("section 4(k)" gives ["k"]), cut out of the page: the line
 * that opens it (see `labeledLine`) with everything nested under it. Each further designator
 * is looked for inside what was found; the search stops, keeping the last block found, when
 * one is missing. Undefined when even the first is not on the page.
 */
export function findSubsection(
  section: UsCodeSection,
  designators: readonly string[],
): UsCodeSection | undefined {
  let lines: readonly StatuteLine[] = section.lines;
  let found = false;
  for (const designator of designators) {
    const at = labeledLine(lines, designator);
    if (at === -1) break;
    lines = blockFrom(lines, at);
    found = true;
  }
  return found ? { heading: section.heading, lines: [...lines] } : undefined;
}

/** The text of a cut-out part, shortened to the per-term cap. */
export function partText(section: UsCodeSection): string {
  return shorten(toText(section.lines), MAX_TERM_CHARS);
}

/** The edition year in a GovInfo page address ("USCODE-2024-title15"), if it has one. */
export function editionYear(url: string): string | undefined {
  return /\/USCODE-(\d{4})-title/.exec(url)?.[1];
}

/** Cut at a word boundary, marking the cut. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const toText = (lines: readonly StatuteLine[]): string =>
  lines.map((l) => l.text).join('\n');

/**
 * The definition of a term in a section: the heading that names it, with everything nested
 * under it, or else the paragraph that says `The term "X" means`. Tries each lookup in turn.
 */
export function findTermBlock(
  section: UsCodeSection,
  lookups: readonly string[],
): string | undefined {
  for (const lookup of lookups) {
    const wanted = normalize(lookup);
    if (!wanted) continue;
    let at = section.lines.findIndex(
      (l) => l.kind === 'head' && headTerm(l.text) === wanted,
    );
    if (at === -1) at = section.lines.findIndex((l) => defines(l, lookup));
    if (at === -1) continue;
    return shorten(toText(blockFrom(section.lines, at)), MAX_TERM_CHARS);
  }
  return undefined;
}

/** The whole section as plain text, shortened. The fallback when a term cannot be isolated. */
export function sectionPlainText(section: UsCodeSection): string {
  return shorten(toText(section.lines), MAX_SECTION_CHARS);
}
