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
import { estimateTokens } from './tokens.js';

export { classifyChunk } from './classify.js';
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

function breadcrumb(path: readonly Section[]): string {
  return path
    .map((section, index) => {
      let num = section.num ?? '';
      if (index === 0 && num && !/^(?:sec(?:tion)?\.?\s|§|\()/i.test(num))
        num = `Sec. ${num}`;
      return [num, section.heading].filter(Boolean).join(' ') || section.id;
    })
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
 * Invalid input or an indivisible word/prefix/metadata over budget fails explicitly;
 * silently shortening legislation would lose source text or citation information.
 */
export function chunkDocument(input: NormalizedDoc): Chunk[] {
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
  ): void {
    const run = textRun(spans);
    const words = Array.from(run.text.matchAll(/\S+/g), (match) => ({
      start: match.index,
      end: match.index + match[0].length,
      sentenceEnd: /[.!?]["'”’)\]]*$/.test(match[0]),
    }));
    if (!words.length) return;
    const prefix = breadcrumb(path);
    const excerpt = (start: number, end: number): string =>
      run.text.slice(words[start]?.start, words[end - 1]?.end);
    const fits = (start: number, end: number, budget: number): boolean =>
      estimateTokens(`${prefix}: ${excerpt(start, end)}`) <= budget;
    let start = 0;
    let previousEnd = 0;

    while (start < words.length) {
      // Shrink overlap if necessary so every iteration includes new source text.
      while (start < previousEnd && !fits(start, previousEnd + 1, TARGET_MAX))
        start++;
      if (!fits(start, start + 1, HARD_MAX))
        throw new AppError(
          'TOO_LARGE',
          'A word or breadcrumb exceeds the chunk token budget.',
        );
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
      const text = excerpt(start, end);
      const includedSpans = run.ranges
        .filter(
          (range) =>
            range.end > range.start &&
            range.start < last.end &&
            range.end > first.start,
        )
        .map((range) => range.span);
      const embedText = `${prefix}: ${text}`;
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
        ...location(includedSpans),
      };
      const { embedText: _omit, ...metadata } = chunk;
      if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') >= METADATA_BYTES)
        throw new AppError(
          'TOO_LARGE',
          'Chunk metadata exceeds the record budget.',
        );
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
      group.flatMap((s, index) =>
        index === 0
          ? s.spans
          : [{ text: '\n\n', status: 'unchanged' as const }, ...s.spans],
      );
    const flush = (): void => {
      if (siblings.length > 1)
        emit(section, path, combinedSpans(siblings), false);
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
  return chunks;
}
