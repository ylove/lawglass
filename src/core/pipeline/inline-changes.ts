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

interface Rendered {
  text: string;
  /** [start, end) of every marked run in `text`. */
  changes: [number, number][];
}

/** Render spans with markers. Whitespace stays outside a marker so `word [struck]x[/struck] y` reads cleanly. */
export function renderWithMarkers(spans: readonly Span[]): Rendered {
  let text = '';
  const changes: [number, number][] = [];
  for (const span of spans) {
    const safe = neutralizeMarkers(span.text);
    if (span.status === 'unchanged' || safe.trim() === '') {
      text += safe;
      continue;
    }
    const lead = safe.length - safe.trimStart().length;
    const core = safe.trim();
    const run =
      core.length > MAX_RUN_CHARS ? `${core.slice(0, MAX_RUN_CHARS)}…` : core;
    const start = text.length + lead;
    const marked = span.status === 'deleted' ? struck(run) : inserted(run);
    text += safe.slice(0, lead) + marked + safe.slice(lead + core.length);
    changes.push([start, start + marked.length]);
  }
  return { text, changes };
}

/** Whole text if it fits the budget, else a window around each change, joined by "…". */
export function windowChanges(
  { text, changes }: Rendered,
  budget: number = MAX_CHANGE_EXCERPT_CHARS,
): string {
  if (text.length <= budget) return text.trim();
  const windows: [number, number][] = [];
  for (const [start, end] of changes) {
    const from = Math.max(0, start - CONTEXT_CHARS);
    const to = Math.min(text.length, end + CONTEXT_CHARS);
    const last = windows.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else windows.push([from, to]);
  }
  const pieces: string[] = [];
  let used = 0;
  for (const [from, to] of windows) {
    const piece = `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
    // The first window always goes in whole: it holds the change the question is about.
    if (pieces.length > 0 && used + piece.length > budget) {
      pieces.push('[more changes in this section are not shown]');
      break;
    }
    pieces.push(piece);
    used += piece.length + 1;
  }
  return pieces.join('\n');
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
      const built = inlineHit(doc, docId, id, hit);
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

function inlineHit(
  doc: Pick<NormalizedDoc, 'sections'>,
  docId: string,
  sectionId: string,
  from: SearchHit,
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
    text: windowChanges(renderWithMarkers(excerpt.spans)),
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
