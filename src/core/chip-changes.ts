/**
 * `what-changes`: built from the document's amendment spans, not from retrieval.
 *
 * Spec §3.3 describes this chip as "filter `amendment_status IN [inserted, deleted]`, group by
 * section". A chunk marked `inserted` is a normal chunk with SOME new wording, so showing it
 * to the model invites it to call existing law "added". The section tree knows exactly which
 * runs are struck and which are underlined, so this executor shows exactly those:
 *
 *   for each changed section, in document order
 *     one status="deleted"  excerpt holding only the struck runs
 *     one status="inserted" excerpt holding only the underlined runs
 *
 * and cites the section, with page and line taken from the spans.
 */
import { answer } from './answer/index.js';
import {
  appendNote,
  syntheticHit,
  type ChipDeps,
  type ChipRun,
  type RunChipOptions,
} from './chip-types.js';
import {
  walkSections,
  ZERO_USAGE,
  type ChipDefinition,
  type SearchHit,
  type Section,
  type Span,
  type SpanStatus,
} from './model/index.js';

/** Most changed sections shown to the model. The rest are counted and reported. */
export const MAX_CHANGED_SECTIONS = 25;
/** Longest run text per excerpt, so one huge repeal cannot crowd out the other sections. */
export const MAX_CHANGE_EXCERPT_CHARS = 3000;

/** Contiguous runs of one status, text trimmed. Whitespace-only runs are dropped. */
function runsWithStatus(
  spans: readonly Span[],
  status: SpanStatus,
): { text: string; page?: number; line?: number }[] {
  const runs: { text: string; page?: number; line?: number }[] = [];
  let open = false;
  for (const span of spans) {
    if (span.status !== status) {
      open = false;
      continue;
    }
    const last = runs.at(-1);
    if (open && last) {
      last.text += span.text;
    } else {
      runs.push({
        text: span.text,
        ...(span.page !== undefined && { page: span.page }),
        ...(span.line !== undefined && { line: span.line }),
      });
      open = true;
    }
  }
  return runs
    .map((r) => ({ ...r, text: r.text.trim() }))
    .filter((r) => r.text !== '');
}

function breadcrumbOf(s: Section): string {
  const label = s.num ? `Sec. ${s.num}` : s.id;
  return s.heading ? `${label} > ${s.heading}` : label;
}

function excerptFor(
  docId: string,
  section: Section,
  status: 'deleted' | 'inserted',
  index: number,
): SearchHit | undefined {
  const runs = runsWithStatus(section.spans, status);
  if (runs.length === 0) return undefined;
  const joined = runs.map((r) => r.text).join(' … ');
  const text =
    joined.length > MAX_CHANGE_EXCERPT_CHARS
      ? `${joined.slice(0, MAX_CHANGE_EXCERPT_CHARS)}…`
      : joined;

  // Location comes from the runs themselves; fall back to the section's own range.
  const pages = runs.flatMap((r) => (r.page === undefined ? [] : [r.page]));
  const pageStart = pages.length ? Math.min(...pages) : section.pageStart;
  const pageEnd = pages.length ? Math.max(...pages) : section.pageEnd;
  const lineStart = runs.find((r) => r.line !== undefined)?.line;
  const lastLine = runs.findLast((r) => r.line !== undefined)?.line;
  return syntheticHit(docId, {
    key: `changes:${String(index)}:${status}`,
    sectionId: section.id,
    breadcrumb: breadcrumbOf(section),
    text,
    amendmentStatus: status,
    location: {
      ...(pageStart !== undefined && { pageStart }),
      ...(pageEnd !== undefined && { pageEnd }),
      ...(lineStart !== undefined && { lineStart }),
      // A last line is only meaningful on the same page as the first.
      ...(lastLine !== undefined &&
        pageStart === pageEnd && { lineEnd: lastLine }),
    },
  });
}

export async function runChangesChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
): Promise<ChipRun> {
  const changed: SearchHit[][] = [];
  for (const section of walkSections(deps.doc.sections)) {
    const pair = (['deleted', 'inserted'] as const).flatMap((status) => {
      const hit = excerptFor(docId, section, status, changed.length);
      return hit ? [hit] : [];
    });
    if (pair.length > 0) changed.push(pair);
  }

  const shown = changed.slice(0, MAX_CHANGED_SECTIONS);
  const hidden = changed.length - shown.length;
  const hits = shown.flat();
  const more =
    hidden > 0
      ? `${String(hidden)} more ${hidden === 1 ? 'section also changes' : 'sections also change'} and ${hidden === 1 ? 'is' : 'are'} not covered here.`
      : '';

  const result = await answer({
    provider: deps.provider,
    question: chip.label,
    context: { hits, metadata: deps.doc.metadata },
    chipInstruction: chip.answerInstruction,
    signal: options.signal,
    onToken: options.onToken,
    maxTokens: options.maxTokens,
  });
  return {
    answer: appendNote(result, more, options.onToken),
    hits,
    backendUsage: ZERO_USAGE,
  };
}
