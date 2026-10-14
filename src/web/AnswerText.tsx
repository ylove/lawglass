// Renders answer text. While streaming, citation markers are hidden (they would flash as raw
// `[S:...]` text); once the answer is final they become numbered superscript buttons.
import type { ReactNode } from 'react';
import { CITATION_PATTERN, type Citation } from '../core/model/index.js';

const MARKER = new RegExp(CITATION_PATTERN.source, 'g');

/** Removes complete markers and a trailing half-typed one, for display mid-stream. */
export function stripMarkers(text: string): string {
  return text.replace(MARKER, '').replace(/\s?\[S?:?[^\]\s]*$/, '');
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
): ReactNode[] {
  interface Frame {
    marker: string;
    key: string;
    children: ReactNode[];
  }
  const root: Frame = { marker: '', key: keyPrefix, children: [] };
  const stack: Frame[] = [];
  const current = () => stack.at(-1) ?? root;
  const close = () => {
    const frame = current();
    stack.pop();
    current().children.push(
      frame.marker === '**' ? (
        <strong key={frame.key}>{frame.children}</strong>
      ) : (
        <em key={frame.key}>{frame.children}</em>
      ),
    );
  };
  // Recognize citations before emphasis so stars inside section ids stay opaque.
  const tokens = new RegExp(`${MARKER.source}|\\\\[\\\\*]|\\*+|\\n`, 'g');
  let last = 0;
  for (const m of line.matchAll(tokens)) {
    current().children.push(line.slice(last, m.index));
    last = m.index + m[0].length;
    const key = `${keyPrefix}-${String(m.index)}`;
    if (m[0] === '\n') {
      current().children.push(<br key={key} />);
      continue;
    }
    if (m[0].startsWith('\\')) {
      current().children.push(m[0].slice(1));
      continue;
    }
    if (m[0].startsWith('*')) {
      let stars = m[0];
      while (stars.length > 0) {
        const closing =
          stack.length > 0 &&
          (stars === current().marker ||
            (stars.length >= 3 && stars.startsWith(current().marker)));
        const marker = closing
          ? current().marker
          : stars.length >= 2
            ? '**'
            : '*';
        // A spaced asterisk (e.g. "2 * 3") is ordinary text, not an opener.
        if (!closing && /\s/.test(line[last] ?? '')) {
          current().children.push(stars);
          break;
        }
        if (closing) close();
        else
          stack.push({
            marker,
            key: `${key}-${String(stars.length)}`,
            children: [],
          });
        stars = stars.slice(marker.length);
      }
      continue;
    }
    const id = m[1] ?? '';
    const n = numbers.get(id);
    if (n === undefined) continue; // invalid or unknown marker: show nothing
    current().children.push(
      <sup key={key}>
        <button
          type="button"
          className="cite"
          aria-label={`Source ${String(n)}`}
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
  current().children.push(line.slice(last));
  // Keep open emphasis formatted while streaming; closing it preserves the same elements.
  while (stack.length > 0) close();
  return root.children;
}

const LIST_ITEM = /^\s*(?:[-*]|(\d+)\.)\s+/;

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
}: {
  text: string;
  citations: readonly Citation[];
  onOpenCitation: OpenCitation;
}) {
  const numbers = numberCitations(text, citations);
  return (
    <>
      {blocks(text).map((block) => {
        const key = String(block.key);
        if (block.kind !== 'p') {
          const List = block.kind;
          return (
            <List
              key={key}
              start={block.kind === 'ol' ? block.start : undefined}
            >
              {block.lines.map((line, li) => (
                <li key={li}>
                  {inline(
                    line,
                    numbers,
                    onOpenCitation,
                    `${key}-${String(li)}`,
                  )}
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={key}>
            {inline(block.lines.join('\n'), numbers, onOpenCitation, key)}
          </p>
        );
      })}
    </>
  );
}
