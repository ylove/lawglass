/**
 * Inline change context for questions that ask what a bill removes or changes.
 *
 * Struck text is indexed in separate `deleted` chunks, so a one-word deletion ("presented")
 * is nearly impossible to retrieve on its own, and the live chunk beside it shows only the
 * new wording. For these questions we rebuild each retrieved section from its spans with the
 * changes in place:
 *
 *   ... defense of the accused's residence [struck]presented[/struck] as described in ...
 *
 * Ordinary questions never come through here, so they never see struck text.
 */
import {
  inserted,
  neutralizeMarkers,
  struck,
  trustMarkers,
} from '../answer/markers.js';
import { coveredSectionIds } from '../answer/citations.js';
import { syntheticHit } from '../chip-types.js';
import { MAX_CHANGE_EXCERPT_CHARS } from '../chip-changes.js';
import { sectionExcerpt } from './excerpt.js';
import type { NormalizedDoc, SearchHit, Span } from '../model/index.js';

/** Unchanged characters kept on each side of a change when a section is too long to show whole. */
const CONTEXT_CHARS = 250;
/** Longest single marked run; a whole struck subsection must not crowd out the other changes. */
const MAX_RUN_CHARS = 1200;

interface Change {
  /** [start, end) of the marked run in `Rendered.text`. */
  start: number;
  end: number;
  /** Start of the run's own words (first 200 chars, lower-cased), for matching retrieved text. */
  plain: string;
  status: 'inserted' | 'deleted';
}

interface Rendered {
  text: string;
  changes: Change[];
}

const squash = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Render spans with markers. Whitespace stays outside a marker so `word [struck]x[/struck] y`
 * reads cleanly.
 *
 * Forgery defense: the document's words are joined FIRST and neutralized as one string, then
 * the real markers are cut in. Neutralizing span by span would miss `[` + a struck space +
 * `struck]`, which only becomes a marker once the spans are joined. Neutralizing keeps the
 * length (one bracket for one bracket), so offsets found before it still hold after it.
 */
export function renderWithMarkers(spans: readonly Span[]): Rendered {
  // Whitespace-only changed spans carry no words, so they are plain text.
  const parts = spans.map((span) => ({
    text: span.text,
    status: span.text.trim() === '' ? 'unchanged' : span.status,
  }));
  const safe = neutralizeMarkers(parts.map((p) => p.text).join(''));
  let text = '';
  let at = 0;
  const changes: Change[] = [];
  for (const part of parts) {
    const piece = safe.slice(at, at + part.text.length);
    at += part.text.length;
    if (part.status === 'unchanged') {
      text += piece;
      continue;
    }
    const lead = piece.length - piece.trimStart().length;
    const core = piece.trim();
    const run =
      core.length > MAX_RUN_CHARS ? `${core.slice(0, MAX_RUN_CHARS)}…` : core;
    const start = text.length + lead;
    const marked = part.status === 'deleted' ? struck(run) : inserted(run);
    text += piece.slice(0, lead) + marked + piece.slice(lead + core.length);
    changes.push({
      start,
      end: start + marked.length,
      plain: squash(core.slice(0, 200)),
      status: part.status,
    });
  }
  return { text, changes };
}

const OMITTED_NOTE = '[more changes in this section are not shown]';

/**
 * Whole text if it fits the budget. Otherwise a window of context around some changes, joined
 * by newlines, never more than `budget` characters. Changes are taken in priority order:
 * struck runs that appear in a retrieved deleted chunk (`focus`, the evidence that matched the
 * question) first, then the rest in document order. Window edges never cut a marker in half.
 */
export function windowChanges(
  { text, changes }: Rendered,
  budget: number = MAX_CHANGE_EXCERPT_CHARS,
  focus: readonly string[] = [],
): string {
  if (text.length <= budget) return text.trim();

  // Each change's own window, with edges moved off any neighbouring marker they would split.
  const own = changes.map((c): [number, number] => {
    let from = Math.max(0, c.start - CONTEXT_CHARS);
    let to = Math.min(text.length, c.end + CONTEXT_CHARS);
    for (const o of changes) {
      if (o.start < from && from < o.end) from = o.end;
      if (o.start < to && to < o.end) to = o.start;
    }
    return [from, to];
  });
  const render = (picked: readonly number[]): string[] => {
    const merged: [number, number][] = [];
    for (const i of [...picked].sort((x, y) => x - y)) {
      const [from, to] = own[i] ?? [0, 0];
      const last = merged.at(-1);
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    return merged.map(
      ([from, to]) =>
        `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`,
    );
  };
  const size = (pieces: readonly string[]): number =>
    pieces.reduce((n, p) => n + p.length, 0) + Math.max(0, pieces.length - 1);

  const wanted = (c: Change): boolean =>
    c.status === 'deleted' && focus.some((f) => f.includes(c.plain));
  const flags = changes.map(wanted);
  const order = changes
    .map((_, i) => i)
    .sort((x, y) => Number(flags[y]) - Number(flags[x]) || x - y);

  // Leave room for the note: it is added whenever something is left out.
  const room = budget - OMITTED_NOTE.length - 1;
  const picked: number[] = [];
  for (const i of order) {
    // Stop at the first that does not fit, so the shown changes are a clean priority prefix.
    if (size(render([...picked, i])) > room) break;
    picked.push(i);
  }
  if (picked.length === 0) {
    // Even one window is too big (a tiny budget): show the most relevant run on its own.
    const c = changes[order[0] ?? 0];
    return c ? text.slice(c.start, c.end) : text.slice(0, budget);
  }
  const pieces = render(picked);
  return (
    picked.length < changes.length ? [...pieces, OMITTED_NOTE] : pieces
  ).join('\n');
}

/**
 * Replace each retrieved section that has amendment markup with one excerpt showing its
 * changes inline. Sections without changes, sections missing from the document, and injected
 * definitions pass through untouched. Excerpts keep the section id, so citations still validate.
 */
export function withInlineChanges(
  hits: readonly SearchHit[],
  doc: Pick<NormalizedDoc, 'sections'>,
  docId: string,
): SearchHit[] {
  const out: SearchHit[] = [];
  const done = new Set<string>();
  for (const hit of hits) {
    const ids = coveredSectionIds(hit.chunk);
    const rebuilt: SearchHit[] = [];
    let complete = true;
    for (const id of ids) {
      if (done.has(id)) continue;
      const built = inlineHit(doc, docId, id, hit, focusFor(hits, id));
      if (built) {
        done.add(id);
        rebuilt.push(built);
      } else {
        complete = false;
      }
    }
    // Keep the original chunk when any of its sections could not be rebuilt, so nothing it
    // covered is lost; a fully rebuilt chunk is replaced by its inline sections.
    if (!complete) out.push(hit);
    out.push(...rebuilt);
  }
  return out;
}

/** Text of the retrieved deleted chunks for one section: what the search actually matched. */
function focusFor(hits: readonly SearchHit[], sectionId: string): string[] {
  return hits
    .filter(
      (h) =>
        h.chunk.amendmentStatus === 'deleted' &&
        coveredSectionIds(h.chunk).includes(sectionId),
    )
    .map((h) => squash(h.chunk.text));
}

function inlineHit(
  doc: Pick<NormalizedDoc, 'sections'>,
  docId: string,
  sectionId: string,
  from: SearchHit,
  focus: readonly string[],
): SearchHit | undefined {
  let excerpt;
  try {
    excerpt = sectionExcerpt(doc, sectionId);
  } catch {
    return undefined; // unknown id: the caller keeps the original hit
  }
  if (excerpt.spans.every((s) => s.status === 'unchanged')) return undefined;
  const hasInserted = excerpt.spans.some((s) => s.status === 'inserted');
  const synthetic = syntheticHit(docId, {
    key: `inline:${sectionId}`,
    sectionId,
    breadcrumb: excerpt.breadcrumb,
    text: windowChanges(
      renderWithMarkers(excerpt.spans),
      MAX_CHANGE_EXCERPT_CHARS,
      focus,
    ),
    // The markers are authoritative; this only tells the model the section is not plain text.
    amendmentStatus: hasInserted ? 'inserted' : 'deleted',
    location: excerpt.location,
  });
  return {
    ...synthetic,
    score: from.score,
    chunk: trustMarkers(synthetic.chunk),
  };
}
