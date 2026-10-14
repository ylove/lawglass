// Renders answer text. While streaming, citation markers are hidden (they would flash as raw
// `[S:...]` text); once the answer is final they become numbered superscript buttons.
import { Fragment, type ReactNode } from 'react';
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
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(MARKER)) {
    const id = m[1] ?? '';
    out.push(line.slice(last, m.index));
    last = m.index + m[0].length;
    const n = numbers.get(id);
    if (n === undefined) continue; // invalid or unknown marker: show nothing
    out.push(
      <sup key={`${keyPrefix}-${String(m.index)}`}>
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
  out.push(line.slice(last));
  return out;
}

const BULLET = /^\s*[-*]\s+/;

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
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim() !== '');
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.every((l) => BULLET.test(l))) {
          return (
            <ul key={bi}>
              {lines.map((l, li) => (
                <li key={li}>
                  {inline(
                    l.replace(BULLET, ''),
                    numbers,
                    onOpenCitation,
                    `${String(bi)}-${String(li)}`,
                  )}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && ' '}
                {inline(
                  l,
                  numbers,
                  onOpenCitation,
                  `${String(bi)}-${String(li)}`,
                )}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
