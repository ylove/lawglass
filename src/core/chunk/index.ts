import {
  assertChunkLimit,
  ParseBudget,
  readParseLimits,
  type ParseControl,
} from '../parse/limits.js';
import {
  AppError,
  NormalizedDoc,
  makeChunkId,
  type Chunk,
  type Section,
  type SourceLocation,
  type Span,
} from '../model/index.js';
import { classifyChunk } from './classify.js';
import { contextualText } from './contextual-text.js';
import { estimateTokens } from './tokens.js';

export { classifyChunk } from './classify.js';
export { contextualText } from './contextual-text.js';
export { estimateTokens } from './tokens.js';

const TARGET_MIN = 300;
const TARGET_MAX = 450;
const HARD_MAX = 480;
const OVERLAP = 50;
const METADATA_BYTES = 30_000;

interface TextRun {
  text: string;
  ranges: { start: number; end: number; span: Span }[];
}

function textRun(spans: readonly Span[]): TextRun {
  let text = '';
  const ranges = spans.map((span) => {
    const start = text.length;
    text += span.text;
    return { start, end: text.length, span };
  });
  return { text, ranges };
}

/** Printed label for a level, keyed by the prefix parsers put on the level's last id segment. */
const LEVEL_LABELS: Readonly<Record<string, string>> = {
  sec: 'Sec.',
  division: 'Division',
  title: 'Title',
  subtitle: 'Subtitle',
  chapter: 'Chapter',
  subchapter: 'Subchapter',
  part: 'Part',
  subpart: 'Subpart',
  article: 'Article',
};

/** True when the printed number already carries its own label ("Sec. 4", "§ 4", "Division A"). */
const ALREADY_LABELLED =
  /^(?:sec(?:tion)?\.?(?:\s|$)|§|\(|(?:division|title|subtitle|chapter|subchapter|part|subpart|article)\b)/i;

/**
 * Labels a level by its id prefix, so a section nested inside a division and title still reads
 * "Sec. 142" and a division reads "Division A". Enumerated children such as "(b)" have no
 * recognised prefix and stay as printed.
 */
export function levelNum(section: Section): string {
  const num = section.num ?? '';
  if (!num || ALREADY_LABELLED.test(num)) return num;
  const prefix = /^([a-z]+)-/.exec(section.id.split('/').at(-1) ?? '')?.[1];
  const label = prefix === undefined ? undefined : LEVEL_LABELS[prefix];
  return label ? `${label} ${num}` : num;
}

export function breadcrumb(path: readonly Section[]): string {
  return path
    .map(
      (section) =>
        [levelNum(section), section.heading].filter(Boolean).join(' ') ||
        section.id,
    )
    .join(' > ');
}

/** Span locations describe the actual excerpt, including when siblings are merged. */
function location(spans: readonly Span[]): SourceLocation {
  const pages = spans.flatMap((span) =>
    span.page === undefined ? [] : [span.page],
  );
  const pageStart = pages.length ? Math.min(...pages) : undefined;
  const pageEnd = pages.length ? Math.max(...pages) : undefined;
  const firstLines = spans.flatMap((span) =>
    span.line !== undefined &&
    (pageStart === undefined || span.page === pageStart)
      ? [span.line]
      : [],
  );
  const lastLines = spans.flatMap((span) =>
    span.line !== undefined && (pageEnd === undefined || span.page === pageEnd)
      ? [span.line]
      : [],
  );
  return {
    ...(pageStart === undefined ? {} : { pageStart, pageEnd }),
    ...(firstLines.length ? { lineStart: Math.min(...firstLines) } : {}),
    ...(lastLines.length ? { lineEnd: Math.max(...lastLines) } : {}),
  };
}

/**
 * Chunks own spans independently of children. Only small adjacent leaf siblings may
 * share a chunk, identified by their parent. Counters also cover parent-owned text.
 * Oversized words split without losing source text. Invalid input or over-budget
 * breadcrumbs/metadata fail explicitly to avoid losing citation information.
 */
export interface ChunkOptions extends ParseControl {
  maxChunks?: number | undefined;
}

export function chunkDocument(
  input: NormalizedDoc,
  options: ChunkOptions = {},
): Chunk[] {
  const budget = new ParseBudget(options);
  const maxChunks = options.maxChunks ?? readParseLimits().maxChunks;
  const parsed = NormalizedDoc.safeParse(input);
  if (!parsed.success)
    throw new AppError('INVALID_INPUT', 'Invalid normalized document.');
  const doc = parsed.data;
  const chunks: Chunk[] = [];
  const counters = new Map<string, number>();
  const sectionIds = new Set<string>();

  function emit(
    section: Section,
    path: readonly Section[],
    spans: readonly Span[],
    deleted: boolean,
    /** Ids of small sibling subsections merged into this chunk (see coveredSectionIds). */
    merged: readonly string[] = [],
  ): void {
    const run = textRun(spans);
    if (!/\S/.test(run.text)) return;
    const prefix = breadcrumb(path);
    if (estimateTokens(`${prefix}: x`) > HARD_MAX)
      throw new AppError(
        'TOO_LARGE',
        'A breadcrumb exceeds the chunk token budget.',
      );
    // The estimator budgets four characters per token; include the prefix and separator.
    const maxWordChars = HARD_MAX * 4 - prefix.length - 2;
    const words = Array.from(run.text.matchAll(/\S+/g)).flatMap((match) => {
      const boundaries = [];
      const wordEnd = match.index + match[0].length;
      for (let start = match.index; start < wordEnd;) {
        let end = Math.min(start + maxWordChars, wordEnd);
        // Keep UTF-16 surrogate pairs together when a split falls inside one.
        if (
          maxWordChars > 1 &&
          end < wordEnd &&
          /[\uD800-\uDBFF]/.test(run.text.slice(end - 1, end))
        )
          end--;
        boundaries.push({
          start,
          end,
          sentenceEnd: end === wordEnd && /[.!?]["'”’)\]]*$/.test(match[0]),
        });
        start = end;
      }
      return boundaries;
    });
    const excerpt = (start: number, end: number): string =>
      run.text.slice(words[start]?.start, words[end - 1]?.end);
    const fits = (start: number, end: number, budget: number): boolean =>
      estimateTokens(`${prefix}: ${excerpt(start, end)}`) <= budget;
    let start = 0;
    let previousEnd = 0;

    while (start < words.length) {
      budget.check();
      // Shrink overlap if necessary so every iteration includes new source text.
      while (start < previousEnd && !fits(start, previousEnd + 1, TARGET_MAX))
        start++;
      let end = start + 1;
      let sentenceEnd = 0;
      while (end <= words.length && fits(start, end, TARGET_MAX)) {
        if (
          end > previousEnd &&
          words[end - 1]?.sentenceEnd &&
          estimateTokens(`${prefix}: ${excerpt(start, end)}`) >= TARGET_MIN
        )
          sentenceEnd = end;
        end++;
      }
      end = Math.max(start + 1, end - 1);
      if (end < words.length && sentenceEnd) end = sentenceEnd;
      const first = words[start];
      const last = words[end - 1];
      if (!first || !last)
        throw new AppError('INVALID_INPUT', 'Missing chunk word boundary.');
      const text = excerpt(start, end).replace(/\n{3,}/g, '\n\n');
      const includedSpans = run.ranges
        .filter(
          (range) =>
            range.end > range.start &&
            range.start < last.end &&
            range.end > first.start,
        )
        .map((range) => range.span);
      const embedText = contextualText({ breadcrumb: prefix, text });
      const n = counters.get(section.id) ?? 0;
      const chunk: Chunk = {
        id: makeChunkId(doc.docId, section.id, n),
        docId: doc.docId,
        sectionId: section.id,
        ...(section.num === undefined ? {} : { sectionNum: section.num }),
        ...(section.heading === undefined ? {} : { heading: section.heading }),
        breadcrumb: prefix,
        chunkType: classifyChunk(text, section.heading),
        amendmentStatus: deleted
          ? 'deleted'
          : includedSpans.some((span) => span.status === 'inserted')
            ? 'inserted'
            : 'unchanged',
        text,
        embedText,
        tokenCount: estimateTokens(embedText),
        definedTermsUsed: [],
        refs: [],
        ...(merged.length > 0
          ? {
              coveredSectionIds: [section.id, ...merged] as [
                string,
                ...string[],
              ],
            }
          : {}),
        ...location(includedSpans),
      };
      const { embedText: _omit, ...metadata } = chunk;
      if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') >= METADATA_BYTES)
        throw new AppError(
          'TOO_LARGE',
          'Chunk metadata exceeds the record budget.',
        );
      assertChunkLimit(chunks.length + 1, maxChunks);
      chunks.push(chunk);
      counters.set(section.id, n + 1);
      if (end === words.length) break;
      previousEnd = end;
      start = end;
      while (start > 0 && estimateTokens(excerpt(start - 1, end)) <= OVERLAP)
        start--;
    }
  }

  function visit(section: Section, ancestors: readonly Section[]): void {
    const path = [...ancestors, section];
    emit(
      section,
      path,
      section.spans.filter((span) => span.status !== 'deleted'),
      false,
    );
    // Deleted chunks follow the section's normal chunks.
    let deleted: Span[] = [];
    for (const span of section.spans) {
      if (span.status === 'deleted') deleted.push(span);
      else if (deleted.length) {
        emit(section, path, deleted, true);
        deleted = [];
      }
    }
    emit(section, path, deleted, true);

    let siblings: Section[] = [];
    const combinedSpans = (group: readonly Section[]): Span[] =>
      group.flatMap((s, index) => {
        const text = textRun(s.spans).text.trimStart();
        const startsWithLabel = (label: string): boolean =>
          text.startsWith(label) &&
          (text.length === label.length ||
            /^[\s.!?:—–(]/.test(text.slice(label.length)));
        // Text/PDF/HTML spans retain printed markers; XML may store only the body.
        const hasNum = s.num !== undefined && startsWithLabel(s.num);
        const hasHeading =
          s.heading !== undefined && startsWithLabel(s.heading);
        const label = hasNum
          ? ''
          : [s.num, hasHeading ? undefined : s.heading]
              .filter(Boolean)
              .join(' ');
        const punctuation =
          s.heading && !hasHeading && !/[.!?:—–]$/.test(label) ? '.' : '';
        return [
          {
            text: `${index === 0 ? '' : '\n\n'}${label ? `${label}${punctuation} ` : ''}`,
            status: 'unchanged' as const,
          },
          ...s.spans,
        ];
      });
    const flush = (): void => {
      if (siblings.length > 1)
        emit(
          section,
          path,
          combinedSpans(siblings),
          false,
          siblings.map((s) => s.id),
        );
      else if (siblings[0]) visit(siblings[0], path);
      siblings = [];
    };
    for (const child of section.children) {
      const text = textRun(child.spans).text.trim();
      const small =
        child.children.length === 0 &&
        text.length > 0 &&
        !child.spans.some((span) => span.status === 'deleted') &&
        estimateTokens(text) < TARGET_MIN;
      if (!small) {
        flush();
        visit(child, path);
      } else {
        const mergedText = textRun(
          combinedSpans([...siblings, child]),
        ).text.trim();
        if (estimateTokens(`${breadcrumb(path)}: ${mergedText}`) > TARGET_MAX)
          flush();
        siblings.push(child);
      }
    }
    flush();
  }

  function validateIds(sections: readonly Section[]): void {
    for (const section of sections) {
      if (sectionIds.has(section.id))
        throw new AppError(
          'INVALID_INPUT',
          'Section ids must be unique within a document.',
        );
      sectionIds.add(section.id);
      validateIds(section.children);
    }
  }
  validateIds(doc.sections);
  for (const section of doc.sections) visit(section, []);
  budget.check();
  return chunks;
}
