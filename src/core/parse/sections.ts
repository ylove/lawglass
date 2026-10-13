import { z } from 'zod';
import { AppError, type Section } from '../model/index.js';

/** PDF callers supply printed coordinates; text callers leave them absent. */
export interface SourceLine {
  text: string;
  page?: number;
  line?: number;
  x?: number;
}

export type HeadingKind = 'article' | 'chapter' | 'section';

export interface SectionPattern {
  kind: HeadingKind | 'enumeration';
  /** Match at line start (after whitespace); capture 1 is the printed marker. */
  regex: RegExp;
}

/** Ordered, replaceable patterns. Decimal dots belong to the section number. */
export const DEFAULT_SECTION_PATTERNS: readonly SectionPattern[] = [
  {
    kind: 'section',
    regex:
      /^(?:Section|SECTION|Sec\.|SEC\.)\s+(\d+(?:\.\d+)*[a-zA-Z]?(?:-[a-zA-Z0-9]+)*)(?!\.?\s+(?:of|and|is|as|to)\b)(?:\.(?=\s|$)|(?=\s*$|\s+That\b))/,
  },
  {
    kind: 'section',
    regex:
      /^§\s*(\d+(?:\.\d+)*[a-zA-Z]?(?:-[a-zA-Z0-9]+)*)(?!\.?\s+(?:of|and|is|as|to)\b)(?:\.(?=\s|$)|(?=\s*$|\s+That\b))/,
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

export interface SectionDetectionOptions {
  /** Replaces the defaults; extend them with [...DEFAULT_SECTION_PATTERNS, ...]. */
  patterns?: readonly SectionPattern[];
}

const sourceLines = z.array(
  z.object({
    text: z.string(),
    page: z.number().int().positive().optional(),
    line: z.number().int().positive().optional(),
    x: z.number().optional(),
  }),
);

type MarkerKind =
  'number' | 'lower-letter' | 'upper-letter' | 'lower-roman' | 'upper-roman';

interface Frame<Kind extends HeadingKind | MarkerKind> {
  section: Section;
  kind: Kind;
  marker: string;
  x: number | undefined;
}

interface Heading {
  kind: SectionPattern['kind'];
  marker: string;
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
      bodyStart: text.length - trimmed.length + match[0].length,
      heading: trimmed
        .slice(match[0].length)
        .trim()
        .replace(/^[.:]\s*/, ''),
    };
  }
  return undefined;
}

interface LinePart {
  text: string;
  match?: Heading;
}

/** Split only leading markers, optionally following a punctuation-delimited heading. */
function splitLine(
  text: string,
  patterns: readonly SectionPattern[],
): LinePart[] {
  const match = matchHeading(text, patterns);
  if (!match) return [{ text }];
  const body = text.slice(match.bodyStart);
  let nextStart = match.bodyStart + body.length - body.trimStart().length;
  let next = matchHeading(text.slice(nextStart), patterns);
  if (next?.kind !== 'enumeration') {
    // Check the first heading boundary only: never scan sentences for references to (a).
    const label = /^[^.:…]*?(?:[.:](?:[—–-])?|…)\s*/.exec(body);
    if (!label) return [{ text, match }];
    nextStart = match.bodyStart + label[0].length;
    next = matchHeading(text.slice(nextStart), patterns);
  }
  if (next?.kind !== 'enumeration') return [{ text, match }];
  return [
    {
      text: text.slice(0, nextStart),
      match: {
        ...match,
        heading: text.slice(match.bodyStart, nextStart).trim(),
      },
    },
    ...splitLine(text.slice(nextStart), patterns),
  ];
}

function markerKind(
  marker: string,
  x: number | undefined,
  stack: readonly Frame<MarkerKind>[],
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

function enumerationDepth(
  kind: MarkerKind,
  x: number | undefined,
  stack: readonly Frame<MarkerKind>[],
): number {
  const previous = stack.at(-1);
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

  function append(section: Section, line: SourceLine, newline: boolean): void {
    section.spans.push({
      text: line.text + (newline ? '\n' : ''),
      status: 'unchanged',
      ...(line.page === undefined ? {} : { page: line.page }),
      ...(line.line === undefined ? {} : { line: line.line }),
    });
    recordLocation(section, line);
  }

  for (const [index, line] of lines.entries()) {
    const parts = splitLine(line.text, patterns);
    for (const [partIndex, part] of parts.entries()) {
      const match = part.match;
      // Markers later on the same line explicitly open children, regardless of alphabet or indent.
      const nested = partIndex > 0;
      const x = nested ? undefined : line.x;
      if (match) {
        let parent: Section | undefined;
        let kind: HeadingKind | MarkerKind;
        let base: string;
        if (match.kind === 'enumeration') {
          kind = markerKind(match.marker, x, enumerations, nested);
          if (!nested)
            enumerations.length = enumerationDepth(kind, x, enumerations);
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
        current = {
          id: uniqueId(base),
          num:
            match.kind === 'enumeration' ? `(${match.marker})` : match.marker,
          ...(match.heading ? { heading: match.heading } : {}),
          level: (parent?.level ?? 0) + 1,
          spans: [],
          children: [],
        };
        (parent?.children ?? roots).push(current);
        const frame = {
          section: current,
          marker: match.marker,
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
          append(current, pending, true);
        leading.length = 0;
      }
      append(
        current,
        { ...line, text: part.text },
        partIndex === parts.length - 1 && index < lines.length - 1,
      );
      for (const frame of [...headings, ...enumerations])
        recordLocation(frame.section, line);
      if (headings.length === 0 && enumerations.length > 0 && preamble)
        recordLocation(preamble, line);
    }
  }
  return roots;
}
