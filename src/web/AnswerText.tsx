// Renders answer text. While streaming, citation markers are hidden (they would flash as raw
// `[S:...]` text); once the answer is final they become numbered superscript buttons.
import type { ReactNode } from 'react';
import { CITATION_PATTERN, type Citation } from '../core/model/index.js';

const MARKER = new RegExp(CITATION_PATTERN.source, 'g');
const MAX_EMPHASIS_DEPTH = 3;
const PUNCTUATION = /^[.,;:!?)]/;
// A marker followed by punctuation takes the whitespace before it along, so removing
// "agreement [S:x]." leaves "agreement." rather than "agreement .".
const MARKER_BEFORE_PUNCTUATION = new RegExp(
  `\\s+(?:${CITATION_PATTERN.source})(?=[.,;:!?)])`,
  'g',
);

/** Removes complete markers and a trailing half-typed one, for display mid-stream. */
export function stripMarkers(text: string): string {
  return text
    .replace(MARKER_BEFORE_PUNCTUATION, '')
    .replace(MARKER, '')
    .replace(/\s?\[S?:?[^\]\s]*$/, '');
}

/** Numbers each distinct valid cited section by order of first appearance. */
export function numberCitations(
  text: string,
  citations: readonly Citation[],
): Map<string, number> {
  const valid = new Set(
    citations.filter((c) => c.valid).map((c) => c.sectionId),
  );
  const numbers = new Map<string, number>();
  for (const m of text.matchAll(MARKER)) {
    const id = m[1];
    if (id && valid.has(id) && !numbers.has(id))
      numbers.set(id, numbers.size + 1);
  }
  return numbers;
}

export type OpenCitation = (sectionId: string, trigger: HTMLElement) => void;

function inline(
  line: string,
  numbers: Map<string, number>,
  open: OpenCitation,
  keyPrefix: string,
  citationLabel: string,
): ReactNode[] {
  interface Frame {
    marker: string;
    key: string;
    children: ReactNode[];
    text: string[];
  }
  const root: Frame = { marker: '', key: keyPrefix, children: [], text: [] };
  const stack: Frame[] = [];
  // Track deeper delimiters without creating nested elements, so their closers also stay literal.
  const literalMarkers: string[] = [];
  const current = () => stack.at(-1) ?? root;
  const flush = (frame: Frame) => {
    if (frame.text.length > 0) {
      frame.children.push(frame.text.join(''));
      frame.text = [];
    }
  };
  const append = (node: ReactNode) => {
    flush(current());
    current().children.push(node);
  };
  const close = (closed = false) => {
    const frame = current();
    stack.pop();
    if (
      frame.children.length === 0 &&
      !frame.text.some((text) => text.trim())
    ) {
      current().text.push(frame.marker, frame.text.join(''));
      if (closed) current().text.push(frame.marker);
      return;
    }
    flush(frame);
    append(
      frame.marker === '**' ? (
        <strong key={frame.key}>{frame.children}</strong>
      ) : (
        <em key={frame.key}>{frame.children}</em>
      ),
    );
  };
  // Recognize citations before emphasis so stars inside section ids stay opaque.
  const tokens = new RegExp(`${MARKER.source}|\\\\[\\\\*\\[]|\\*+|\\n`, 'g');
  let last = 0;
  for (const m of line.matchAll(tokens)) {
    if (m.index > last) current().text.push(line.slice(last, m.index));
    last = m.index + m[0].length;
    const key = `${keyPrefix}-${String(m.index)}`;
    if (m[0] === '\n') {
      append(<br key={key} />);
      continue;
    }
    if (m[0].startsWith('\\')) {
      current().text.push(m[0].slice(1));
      continue;
    }
    if (m[0].startsWith('*')) {
      let offset = 0;
      while (offset < m[0].length) {
        const remaining = m[0].length - offset;
        const top = literalMarkers.at(-1) ?? current().marker;
        const closing =
          top !== '' && (remaining === top.length || remaining >= 3);
        const marker = closing ? top : remaining >= 2 ? '**' : '*';
        // A spaced asterisk (e.g. "2 * 3") is ordinary text, not an opener.
        if (!closing && /\s/.test(line[last] ?? '')) {
          current().text.push(m[0].slice(offset));
          break;
        }
        if (
          literalMarkers.length > 0 ||
          (!closing && stack.length >= MAX_EMPHASIS_DEPTH)
        ) {
          current().text.push(marker);
          if (closing) literalMarkers.pop();
          else literalMarkers.push(marker);
        } else if (closing) close(true);
        else
          stack.push({
            marker,
            key: `${key}-${String(remaining)}`,
            children: [],
            text: [],
          });
        offset += marker.length;
      }
      continue;
    }
    // Drop the gap before the marker when punctuation follows it, in both the shown and hidden cases.
    if (PUNCTUATION.test(line.slice(last))) {
      const pending = current().text;
      while (pending.length > 0) {
        const trimmed = (pending.at(-1) ?? '').trimEnd();
        if (trimmed) {
          pending[pending.length - 1] = trimmed;
          break;
        }
        pending.pop();
      }
    }
    const id = m[1] ?? '';
    const n = numbers.get(id);
    if (n === undefined) continue; // invalid or unknown marker: show nothing
    append(
      <sup key={key}>
        <button
          type="button"
          className="cite"
          aria-label={`${citationLabel} ${String(n)}`}
          aria-haspopup="dialog"
          onClick={(e) => {
            open(id, e.currentTarget);
          }}
        >
          {n}
        </button>
      </sup>,
    );
  }
  if (last < line.length) current().text.push(line.slice(last));
  // Keep open emphasis formatted while streaming; closing it preserves the same elements.
  while (stack.length > 0) close();
  flush(root);
  return root.children;
}

const LIST_ITEM = /^\s*(?:[-*]|(\d+)\.)\s+(?=\S)/;

interface Block {
  kind: 'p' | 'ul' | 'ol';
  lines: string[];
  start: number;
  key: number;
}

function blocks(text: string): Block[] {
  const result: Block[] = [];
  let block: Block | undefined;
  for (const [index, line] of text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .entries()) {
    if (!line.trim()) {
      block = undefined;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    const kind = item ? (item[1] === undefined ? 'ul' : 'ol') : 'p';
    if (block?.kind !== kind) {
      block = { kind, lines: [], start: Number(item?.[1] ?? 1), key: index };
      result.push(block);
    }
    block.lines.push(item ? line.slice(item[0].length) : line);
  }
  return result;
}

export function AnswerText({
  text,
  citations,
  onOpenCitation,
  citationLabel = 'Source',
}: {
  text: string;
  citations: readonly Citation[];
  onOpenCitation: OpenCitation;
  /** Accessible name prefix for the numbered buttons; a second block on a page needs its own. */
  citationLabel?: string;
}) {
  const numbers = numberCitations(text, citations);
  return (
    <>
      {blocks(text).map((block) => {
        const key = String(block.key);
        if (block.kind !== 'p') {
          const List = block.kind;
          const items = block.lines.map((line, li) =>
            inline(
              line,
              numbers,
              onOpenCitation,
              `${key}-${String(li)}`,
              citationLabel,
            ),
          );
          const nonempty = items.map((children, li) =>
            children.some(
              (child) => typeof child !== 'string' || child.trim(),
            ) ? (
              <li key={li}>{children}</li>
            ) : null,
          );
          if (nonempty.every((item) => item === null)) return null;
          return (
            <List
              key={key}
              start={block.kind === 'ol' ? block.start : undefined}
            >
              {nonempty}
            </List>
          );
        }
        return (
          <p key={key}>
            {inline(
              block.lines.join('\n'),
              numbers,
              onOpenCitation,
              key,
              citationLabel,
            )}
          </p>
        );
      })}
    </>
  );
}
