import { z } from 'zod';
import { AppError, SpanStatus, type Section } from '../model/index.js';

/** PDF callers supply printed coordinates; text callers leave them absent. */
export interface SourceLine {
  text: string;
  page?: number;
  line?: number;
  x?: number;
  /**
   * Amendment status of each UTF-16 code unit of `text` (struck or underlined text in PDFs).
   * Absent means every character is unchanged. Detection reads the text only; statuses are
   * carried through to the spans so a struck run stays `deleted` in whatever section it lands.
   */
  statuses?: readonly SpanStatus[];
  /**
   * Layout says this line continues the paragraph above it (in a first-line-indent PDF it
   * starts at the left margin), so it never opens a section even if it begins "(F) of ...".
   */
  continuation?: boolean;
  /** An HTML heading element explicitly marks this line as a printed heading. */
  printedHeading?: boolean;
}

export type HeadingKind = 'article' | 'chapter' | 'section';

export interface SectionPattern {
  kind: HeadingKind | 'enumeration';
  /** Match at line start (after whitespace); capture 1 is the printed marker. */
  regex: RegExp;
}

/**
 * Lowercase words that, right after a section number at the start of a line, show a
 * cross-reference that wrapped onto a new line ("section 9 of", "Section 9 shall apply")
 * rather than a heading. Modals and verbs were added for issue #51.
 */
const REFERENCE_CONTINUATIONS = [
  ...['of', 'and', 'or', 'as', 'to', 'in', 'on', 'for', 'by', 'with'],
  ...['under', 'from', 'is', 'are', 'was', 'were', 'be', 'has', 'have'],
  ...['had', 'shall', 'may', 'must', 'will', 'can', 'should', 'would'],
  ...['could', 'apply', 'applies', 'does', 'do', 'did', 'means'],
  ...['provides', 'requires', 'takes', 'governs'],
].join('|');
const SECTION_NUMBER = String.raw`(\d+(?:\.\d+)*[a-zA-Z]?(?:-[a-zA-Z0-9]+)*)`;
const SECTION_TAIL = String.raw`(?!\.?\s+(?:${REFERENCE_CONTINUATIONS})\b)(?:\.(?=\s|$|-)|(?=\s|$))`;

/**
 * Charters print "Sec. 3. - Legislative powers." and "Sec. 3.- Legislative powers.": the
 * dash is a separator, not part of the heading. A lone ".", ":" or dash is dropped too.
 */
const LEADING_HEADING_PUNCTUATION = /^(?:[.:]\s*)?(?:[-\u2013\u2014]+\s*)?/;

/** Ordered, replaceable patterns. Decimal dots belong to the section number. */
export const DEFAULT_SECTION_PATTERNS: readonly SectionPattern[] = [
  {
    kind: 'section',
    regex: new RegExp(
      String.raw`^(?:Section|SECTION|Sec\.?|SEC\.?)\s+${SECTION_NUMBER}${SECTION_TAIL}`,
    ),
  },
  {
    kind: 'section',
    regex: new RegExp(String.raw`^§\s*${SECTION_NUMBER}${SECTION_TAIL}`),
  },
  {
    kind: 'article',
    regex: /^article\s+(\d+|[ivxlcdm]+|[a-z])(?:[.:](?=\s|$)|(?=\s|$))/i,
  },
  {
    kind: 'chapter',
    regex: /^chapter\s+(\d+|[ivxlcdm]+|[a-z])(?:[.:](?=\s|$)|(?=\s|$))/i,
  },
  {
    kind: 'enumeration',
    regex: /^\((\d+|[a-z]+)\)(?=\s|\(|$)/i,
  },
];

/**
 * Decides whether a `section`-kind marker is one of the document's own sections. A rejected
 * marker is quoted statute text: it becomes a child container of the current section, so
 * its subdivisions nest under it instead of continuing the previous subdivision stack.
 */
export interface SectionGate {
  /**
   * `lines` starts with the rest of the marker's line, followed by the next few lines.
   */
  accept(marker: string, lines: readonly GateLine[]): boolean;
  /** Sees every line (as amended) before it is split, e.g. to reset numbering at PART lines. */
  observe?(lineText: string): void;
  /** A label such as "Part B" for bill sections opened now; it leads their heading. */
  qualifier?(): string | undefined;
}

export interface GateLine {
  text: string;
  /** One flag per character of `text`: struck or inserted. */
  changed: readonly boolean[];
}

/** How many lines a gate may read to find the end of a section's opening clause. */
const GATE_LOOKAHEAD_LINES = 10;

export interface SectionDetectionOptions {
  /** Replaces the defaults; extend them with [...DEFAULT_SECTION_PATTERNS, ...]. */
  patterns?: readonly SectionPattern[];
  /**
   * Called once per detection run; the returned function decides whether a `section`-kind
   * marker really opens a section. A rejected marker stays ordinary text of the current
   * section. Bills use this so numbers inside quoted statutory text cannot become sections.
   */
  createSectionGate?: () => SectionGate;
  /**
   * Bill sections carry no real titles. When set, a section heading is kept only if it is a
   * short leading phrase ending in a period ("Short title."), never the rest of the line.
   */
  shortSectionHeadings?: boolean;
  /**
   * NJ prints `a.`, `(1)`, `(a)`, `(i)` with the same indent, and `(a)` reuses the letters of
   * `a.`. With this set, a level's first marker (a, 1, i) after a different kind is a child,
   * not a peer of the earlier same-kind marker.
   */
  nestRestartedMarkers?: boolean;
}

const sourceLines = z.array(
  z
    .object({
      text: z.string(),
      page: z.number().int().positive().optional(),
      line: z.number().int().positive().optional(),
      x: z.number().optional(),
      statuses: z.array(SpanStatus).optional(),
      continuation: z.boolean().optional(),
      printedHeading: z.boolean().optional(),
    })
    .refine(
      ({ text, statuses }) => !statuses || statuses.length === text.length,
      'statuses must have one entry per character of text',
    ),
);

type MarkerKind =
  | 'number'
  | 'lower-letter'
  | 'upper-letter'
  | 'lower-roman'
  | 'upper-roman'
  /** A quoted statute's own section number inside a bill section. Never a sibling. */
  | 'quoted';

type MarkerForm = 'paren' | 'dot';

interface Frame<Kind extends HeadingKind | MarkerKind> {
  section: Section;
  kind: Kind;
  marker: string;
  form?: MarkerForm;
  x: number | undefined;
}

interface Heading {
  kind: SectionPattern['kind'];
  /** Set by the section gate: a rejected section marker kept as a quoted container. */
  quoted?: boolean;
  marker: string;
  /** "(a)" prints in parentheses; "a." with a dot. NJ uses both for the same letters. */
  form: MarkerForm;
  heading: string;
  /** Offset of the text after the printed marker, including leading whitespace. */
  bodyStart: number;
}

// Canonical Roman numerals, rather than any string made of Roman letters (e.g. "civil").
const ROMAN =
  /^(?=[ivxlcdm]+$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
const HEADING_RANK: Record<HeadingKind, number> = {
  article: 1,
  chapter: 2,
  section: 3,
};
const INDENT_TOLERANCE = 1;
const LETTER = /^(?:[a-z]|[A-Z]|([a-z])\1|([A-Z])\2)$/;

/** Legislative letter sequences run a … z, aa, bb … zz. */
function letterOrdinal(marker: string): number {
  return marker.toLowerCase().charCodeAt(0) - 97 + 26 * (marker.length - 1);
}

function matchHeading(
  text: string,
  patterns: readonly SectionPattern[],
): Heading | undefined {
  const trimmed = text.trimStart();
  // Recitals are content, even if they mention a section or start with an enumeration.
  if (/^(?:\([a-z0-9]+\)\s*)?(?:whereas\b|recitals?\b)/i.test(trimmed)) return;
  for (const { kind, regex } of patterns) {
    // Clone so global/sticky caller patterns cannot leak lastIndex between lines or calls.
    const match = new RegExp(regex.source, regex.flags).exec(trimmed);
    if (match?.index !== 0) continue;
    const marker = match[1];
    if (!marker || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(marker)) {
      throw new AppError(
        'INVALID_INPUT',
        'A section pattern must capture a citation-safe marker.',
      );
    }
    if (
      kind === 'enumeration' &&
      !/^\d+$/.test(marker) &&
      !LETTER.test(marker) &&
      !ROMAN.test(marker)
    )
      continue;
    return {
      kind,
      marker,
      form: trimmed.startsWith('(') ? 'paren' : 'dot',
      bodyStart: text.length - trimmed.length + match[0].length,
      heading: trimmed
        .slice(match[0].length)
        .trim()
        .replace(LEADING_HEADING_PUNCTUATION, ''),
    };
  }
  return undefined;
}

/** Whether a line begins with something the patterns would open as a section. */
export function startsWithHeading(
  text: string,
  patterns: readonly SectionPattern[] = DEFAULT_SECTION_PATTERNS,
): boolean {
  return matchHeading(text, patterns) !== undefined;
}

interface LinePart {
  text: string;
  match?: Heading;
  nested?: boolean;
}

type MarkerContext = Pick<Frame<MarkerKind>, 'kind' | 'marker' | 'x' | 'form'>;

function romanOrdinal(marker: string): number {
  const values: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };
  const digits = Array.from(
    marker.toLowerCase(),
    (digit) => values[digit] ?? 0,
  );
  return digits.reduce(
    (total, value, index) =>
      total + (value < (digits[index + 1] ?? 0) ? -value : value),
    0,
  );
}

function isNextSibling(current: MarkerContext, next: string): boolean {
  switch (current.kind) {
    case 'quoted':
      return false;
    case 'number':
      return /^\d+$/.test(next) && Number(next) === Number(current.marker) + 1;
    case 'lower-letter':
    case 'upper-letter':
      return (
        LETTER.test(next) &&
        (next === next.toLowerCase()) === (current.kind === 'lower-letter') &&
        letterOrdinal(next) === letterOrdinal(current.marker) + 1
      );
    case 'lower-roman':
    case 'upper-roman':
      return (
        ROMAN.test(next) &&
        (next === next.toLowerCase()) === (current.kind === 'lower-roman') &&
        romanOrdinal(next) === romanOrdinal(current.marker) + 1
      );
  }
}

/**
 * Split leading chains and plausible continuations at the first heading boundary.
 * `inColonList` is set once a colon has introduced inline items on this line
 * ("(a) The following: (1) x; (2) y; and (3) z."): their siblings may then follow a semicolon.
 */
function splitLine(
  text: string,
  patterns: readonly SectionPattern[],
  stack: readonly MarkerContext[],
  x: number | undefined,
  nested = false,
  inColonList = false,
  restartNesting = false,
): LinePart[] {
  const match = matchHeading(text, patterns);
  if (!match) return [{ text }];
  const context = [...stack];
  let current: MarkerContext | undefined;
  if (match.kind === 'enumeration') {
    const kind = markerKind(
      match.marker,
      restartNesting ? undefined : x,
      context,
      nested,
    );
    if (!nested)
      context.length = enumerationDepth(
        kind,
        x,
        context,
        restartNesting ? match.marker : undefined,
        match.form,
      );
    current = { kind, marker: match.marker, form: match.form, x };
    context.push(current);
  } else {
    context.length = 0;
  }
  const body = text.slice(match.bodyStart);
  let nextStart = match.bodyStart + body.length - body.trimStart().length;
  let next = matchHeading(text.slice(nextStart), patterns);
  const leadingChain = next?.kind === 'enumeration';
  let opensColonList = false;
  if (next?.kind !== 'enumeration') {
    // Check the first heading boundary only: never scan sentences for references to (a).
    const label = /^[^.:…]*?(?:[.:](?:[—–-])?|…)\s*/.exec(body);
    if (label) {
      nextStart = match.bodyStart + label[0].length;
      next = matchHeading(text.slice(nextStart), patterns);
      opensColonList = label[0].includes(':');
    }
  }
  if (next?.kind !== 'enumeration' && inColonList && current) {
    // Inside a colon-introduced list, the next item follows "; ", "; and " or "; or ".
    // Only the first semicolon is checked, and only the next peer marker opens a sibling.
    const boundary = /;\s+(?:(?:and|or)\s+)?/.exec(body);
    const candidate = boundary
      ? matchHeading(body.slice(boundary.index + boundary[0].length), patterns)
      : undefined;
    if (
      boundary &&
      candidate?.kind === 'enumeration' &&
      isNextSibling(current, candidate.marker)
    ) {
      nextStart = match.bodyStart + boundary.index + boundary[0].length;
      next = candidate;
    }
  }
  if (next?.kind !== 'enumeration') return [{ text, match, nested }];
  const sibling = current !== undefined && isNextSibling(current, next.marker);
  const firstChild =
    /^(?:1|a|A|i|I)$/.test(next.marker) &&
    (!current ||
      leadingChain ||
      markerKind(next.marker, undefined, context, true) !== current.kind);
  // An inline reference can follow punctuation too; only a next peer or a level's
  // initial marker can open structure, and a following verb signals prose.
  if (
    (!sibling && !firstChild) ||
    /^(?:is|are|was|were|be|been|being|means|mean|shall|must|may|can|will|has|have|had|does|do|did)\b/i.test(
      next.heading,
    )
  )
    return [{ text, match, nested }];
  return [
    {
      text: text.slice(0, nextStart),
      nested,
      match: {
        ...match,
        heading: text.slice(match.bodyStart, nextStart).trim(),
      },
    },
    ...splitLine(
      text.slice(nextStart),
      patterns,
      context,
      undefined,
      !sibling,
      inColonList || opensColonList,
      restartNesting,
    ),
  ];
}

function markerKind(
  marker: string,
  x: number | undefined,
  stack: readonly MarkerContext[],
  nested = false,
): MarkerKind {
  if (/^\d+$/.test(marker)) return 'number';
  const lower = marker === marker.toLowerCase();
  const letter: MarkerKind = lower ? 'lower-letter' : 'upper-letter';
  const roman: MarkerKind = lower ? 'lower-roman' : 'upper-roman';
  if (!ROMAN.test(marker)) return letter;

  // Equal indents resolve ambiguous (i)/(I) using the established level's alphabet.
  if (!nested && marker.length === 1 && x !== undefined) {
    const peer = stack.findLast(
      (frame) =>
        frame.x !== undefined &&
        Math.abs(frame.x - x) <= INDENT_TOLERANCE &&
        (frame.kind === letter || frame.kind === roman),
    );
    if (peer) return peer.kind;
  }
  const previous = stack.findLast((frame) => frame.kind === letter);
  if (
    !nested &&
    previous &&
    LETTER.test(marker) &&
    letterOrdinal(marker) === letterOrdinal(previous.marker) + 1 &&
    !(
      x !== undefined &&
      previous.x !== undefined &&
      x > previous.x + INDENT_TOLERANCE
    )
  ) {
    return letter;
  }
  if (marker.length > 1) return roman;
  if (stack.some((frame) => frame.kind === roman)) return roman;
  // i/I typically starts a Roman level; other single Roman letters default to letters.
  return marker.toLowerCase() === 'i' ? roman : letter;
}

const FIRST_MARKER = /^(?:1|[aA]|[iI])$/;

function enumerationDepth(
  kind: MarkerKind,
  x: number | undefined,
  stack: readonly MarkerContext[],
  marker?: string,
  form?: MarkerForm,
): number {
  const previous = stack.at(-1);
  if (marker !== undefined) {
    // Same-indent bills: the marker closes everything below the frame it follows in sequence,
    // which tells `c.` (after `b.`'s whole subtree) from `(c)` (after `(b)`). `b.` never
    // follows a lone `(a)`: the dotted and parenthesised letters are different levels.
    const sibling = stack.findLastIndex(
      (frame) =>
        isNextSibling(frame, marker) &&
        (form === undefined || frame.form === undefined || frame.form === form),
    );
    if (sibling >= 0) return sibling;
    if (previous && previous.kind !== kind && FIRST_MARKER.test(marker))
      return stack.length;
  }
  if (x !== undefined && previous?.x !== undefined) {
    if (x > previous.x + INDENT_TOLERANCE) return stack.length;
    if (x < previous.x - INDENT_TOLERANCE) {
      const ancestor = stack.findLastIndex(
        (frame) => frame.x !== undefined && frame.x <= x + INDENT_TOLERANCE,
      );
      if (ancestor < 0) return 0;
      const indent = stack[ancestor]?.x;
      return indent !== undefined && Math.abs(indent - x) <= INDENT_TOLERANCE
        ? ancestor
        : ancestor + 1;
    }
  }
  const peer = stack.findLastIndex((frame) => frame.kind === kind);
  return peer < 0 ? stack.length : peer;
}

/**
 * The line as amended: struck characters removed, with a map from each visible character to
 * its offset in the original text. A space left doubled by a removal is dropped, so a struck
 * word between kept words reads as one gap ("Section 2. ~~Old~~ New" -> "Section 2. New").
 */
function visibleText(line: SourceLine): { text: string; offsets: number[] } {
  if (!line.statuses?.includes('deleted'))
    return {
      text: line.text,
      offsets: Array.from({ length: line.text.length }, (_, index) => index),
    };
  let text = '';
  const offsets: number[] = [];
  let removed = false;
  for (let index = 0; index < line.text.length; index++) {
    const char = line.text.charAt(index);
    if (line.statuses[index] === 'deleted') {
      removed = true;
      continue;
    }
    const doubled = /\s/.test(char) && (text === '' || /\s$/.test(text));
    if (!(removed && doubled)) {
      text += char;
      offsets.push(index);
    }
    removed = false;
  }
  return { text, offsets };
}

interface StatusRun {
  start: number;
  end: number;
  status: SpanStatus;
}

/** Maximal runs of one status in `[start, end)`; always at least one run, even when empty. */
function statusRuns(
  statuses: readonly SpanStatus[] | undefined,
  start: number,
  end: number,
): StatusRun[] {
  const runs: StatusRun[] = [];
  for (let index = start; index < end; index++) {
    const status = statuses?.[index] ?? 'unchanged';
    const last = runs.at(-1);
    if (last?.status === status) last.end = index + 1;
    else runs.push({ start: index, end: index + 1, status });
  }
  return runs.length > 0 ? runs : [{ start, end, status: 'unchanged' }];
}

function recordLocation(section: Section, line: SourceLine): void {
  if (line.page !== undefined) {
    section.pageStart ??= line.page;
    section.pageEnd = line.page;
  }
  if (line.line !== undefined) {
    section.lineStart ??= line.line;
    section.lineEnd = line.line;
  }
}

/** Subdivision body sentences are not titles; only explicit heading signals name them. */
export function subdivisionHeading(
  body: string,
  printedHeading = false,
): string | undefined {
  const text = body.trim();
  if (!text) return undefined;
  const dashed = /^([^.—–\n]+\.(?:[—–]|--(?!-)))/.exec(text);
  if (dashed) return dashed[1];
  if (printedHeading || (/[A-Z]/.test(text) && text === text.toUpperCase()))
    return text;
  return undefined;
}

/**
 * Ohio-style code sections often put the first body clause after the number on the same
 * line. A prose opener is not a title; explicit typography still wins ("The board.—").
 * Keep ordinary short titles, including "Section 5747.01 Short title".
 */
export function sectionHeading(
  body: string,
  marker: string | undefined,
  printedHeading = false,
): string | undefined {
  if (
    marker?.includes('.') &&
    /^(?:A|An|The|Each|Any|Every|No|If|When|Unless|Except|As|Notwithstanding|Subject|That)\b/i.test(
      body,
    )
  )
    return subdivisionHeading(body, printedHeading);
  return body || undefined;
}

const PROSE_OPENER =
  /^(?:A|An|The|This|That|Such|Each|Any|Every|No|Nothing|If|When|Unless|Except|As|Notwithstanding|Subject|Subdivision|Subdivisions|Paragraph|Subparagraph|Section|Sections|Subsection|Article|Chapter|Title|Within|Upon|For|In|On|Within|All)\b/;

/** "Short title. This act shall be..." -> "Short title."; prose and long openings -> none. */
export function shortLeadingHeading(body: string): string | undefined {
  const phrase = /^([A-Z][^.:;]*\.)(?=\s|$)/.exec(body.trim())?.[1];
  if (!phrase || PROSE_OPENER.test(phrase)) return undefined;
  return phrase.split(/\s+/).length <= 6 ? phrase : undefined;
}

/**
 * Infer a section tree without changing source text. Inline markers split a line into unchanged
 * spans; newlines between lines make sectionText() readable. Parent ranges include descendants,
 * but parent spans contain only their own text. No printed coordinates are invented.
 */
export function detectSections(
  lines: readonly SourceLine[],
  options: SectionDetectionOptions = {},
): Section[] {
  if (!sourceLines.safeParse(lines).success) {
    throw new AppError('INVALID_INPUT', 'Invalid section source lines.');
  }
  const patterns = options.patterns ?? DEFAULT_SECTION_PATTERNS;
  const sectionGate = options.createSectionGate?.();
  const roots: Section[] = [];
  const headings: Frame<HeadingKind>[] = [];
  const enumerations: Frame<MarkerKind>[] = [];
  const usedIds = new Set<string>();
  const collisions = new Map<string, number>();
  let current: Section | undefined;
  let preamble: Section | undefined;
  const leading: SourceLine[] = [];

  function uniqueId(base: string): string {
    let id = base;
    let count = collisions.get(base) ?? 1;
    while (usedIds.has(id)) id = `${base}~${String(++count)}`;
    collisions.set(base, count);
    usedIds.add(id);
    return id;
  }

  function getPreamble(): Section {
    if (!preamble) {
      preamble = {
        id: uniqueId('preamble'),
        level: 1,
        spans: [],
        children: [],
      };
      roots.push(preamble);
    }
    return preamble;
  }

  /** Append `line.text[start, end)` as one span per status run; the newline joins the last. */
  function append(
    section: Section,
    line: SourceLine,
    start: number,
    end: number,
    newline: boolean,
  ): void {
    const runs = statusRuns(line.statuses, start, end);
    for (const [index, run] of runs.entries()) {
      section.spans.push({
        text:
          line.text.slice(run.start, run.end) +
          (newline && index === runs.length - 1 ? '\n' : ''),
        status: run.status,
        ...(line.page === undefined ? {} : { page: line.page }),
        ...(line.line === undefined ? {} : { line: line.line }),
      });
    }
    recordLocation(section, line);
  }

  /** The marker's line from `partStart` plus the lines after it, for the section gate. */
  function gateLines(index: number, partStart: number): GateLine[] {
    return lines
      .slice(index, index + GATE_LOOKAHEAD_LINES)
      .map((line, offset) => {
        const from = offset === 0 ? partStart : 0;
        return {
          text: line.text.slice(from),
          changed: Array.from(
            line.text.slice(from),
            (_char, at) =>
              (line.statuses?.[from + at] ?? 'unchanged') !== 'unchanged',
          ),
        };
      });
  }

  for (const [index, line] of lines.entries()) {
    // Structure (num, heading, nesting) is read from the text as amended; struck characters
    // still go into the spans, as deleted runs, via the offset map.
    const visible = visibleText(line);
    sectionGate?.observe?.(visible.text);
    const parts: LinePart[] = line.continuation
      ? [{ text: visible.text }]
      : splitLine(
          visible.text,
          patterns,
          enumerations,
          line.x,
          false,
          false,
          options.nestRestartedMarkers,
        );
    let partStart = 0;
    let visibleStart = 0;
    for (const [partIndex, part] of parts.entries()) {
      visibleStart += part.text.length;
      // Struck text at a boundary stays with the part before it; the last part takes the rest.
      const partEnd =
        partIndex === parts.length - 1
          ? line.text.length
          : (visible.offsets[visibleStart] ?? line.text.length);
      const rejected =
        part.match?.kind === 'section' &&
        sectionGate &&
        !sectionGate.accept(part.match.marker, gateLines(index, partStart));
      const match: Heading | undefined =
        part.match && rejected
          ? { ...part.match, kind: 'enumeration', quoted: true }
          : part.match;
      const nested = part.nested ?? false;
      const x = partIndex > 0 ? undefined : line.x;
      if (match) {
        let parent: Section | undefined;
        let kind: HeadingKind | MarkerKind;
        let base: string;
        if (match.quoted) {
          kind = 'quoted';
          enumerations.length = 0;
          parent = headings.at(-1)?.section ?? getPreamble();
          base = `${parent.id}/${match.marker.toLowerCase()}`;
        } else if (match.kind === 'enumeration') {
          kind = markerKind(
            match.marker,
            options.nestRestartedMarkers ? undefined : x,
            enumerations,
            nested,
          );
          if (!nested)
            enumerations.length = enumerationDepth(
              kind,
              x,
              enumerations,
              options.nestRestartedMarkers ? match.marker : undefined,
              match.form,
            );
          parent =
            enumerations.at(-1)?.section ??
            headings.at(-1)?.section ??
            getPreamble();
          base = `${parent.id}/${match.marker.toLowerCase()}`;
        } else {
          kind = match.kind;
          enumerations.length = 0;
          let ancestor = headings.at(-1);
          while (
            ancestor &&
            HEADING_RANK[ancestor.kind] >= HEADING_RANK[kind]
          ) {
            headings.pop();
            ancestor = headings.at(-1);
          }
          parent = ancestor?.section;
          const prefix = kind === 'section' ? 'sec' : kind;
          base = `${parent ? `${parent.id}/` : ''}${prefix}-${match.marker.toLowerCase()}`;
        }
        const heading =
          match.kind === 'enumeration'
            ? subdivisionHeading(match.heading, line.printedHeading)
            : match.kind === 'section'
              ? options.shortSectionHeadings
                ? shortLeadingHeading(match.heading)
                : sectionHeading(
                    match.heading,
                    match.marker,
                    line.printedHeading,
                  )
              : match.heading;
        const part =
          match.kind === 'section' ? sectionGate?.qualifier?.() : undefined;
        current = {
          id: uniqueId(base),
          // A quoted statute section reads "§ 1509", never "(1509)", which looks like a
          // paragraph of the bill section that quotes it.
          num: match.quoted
            ? `§ ${match.marker}`
            : match.kind === 'enumeration'
              ? `(${match.marker})`
              : match.marker,
          ...(heading || part
            ? { heading: [part, heading].filter(Boolean).join('. ') }
            : {}),
          level: (parent?.level ?? 0) + 1,
          spans: [],
          children: [],
        };
        (parent?.children ?? roots).push(current);
        const frame = {
          section: current,
          marker: match.marker,
          form: match.form,
          x,
        };
        if (kind === 'article' || kind === 'chapter' || kind === 'section') {
          headings.push({ ...frame, kind });
        } else {
          enumerations.push({ ...frame, kind });
        }
      }
      if (!current) {
        leading.push(line);
        if (!line.text.trim()) continue;
        current = getPreamble();
        for (const pending of leading.slice(0, -1))
          append(current, pending, 0, pending.text.length, true);
        leading.length = 0;
      }
      append(
        current,
        line,
        partStart,
        partEnd,
        partIndex === parts.length - 1 && index < lines.length - 1,
      );
      partStart = partEnd;
      for (const frame of [...headings, ...enumerations])
        recordLocation(frame.section, line);
      if (headings.length === 0 && enumerations.length > 0 && preamble)
        recordLocation(preamble, line);
    }
  }
  return roots;
}
