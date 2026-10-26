/**
 * `what-changes`: built from the document's amendment spans, not from retrieval.
 *
 * Spec §3.3 describes this chip as "filter `amendment_status IN [inserted, deleted]`, group by
 * section". A chunk marked `inserted` is a normal chunk with SOME new wording, so showing it
 * to the model invites it to call existing law "added". The section tree knows exactly which
 * runs are struck and which are underlined, so this executor works from those.
 *
 * Context. Ohio amends word by word ("has [-a right-] [+no duty+] to [-be-] [+retreat+]"), and
 * a bare list of struck words means nothing. So each changed section is shown as sentences:
 *
 *   status="deleted"   the BEFORE text: unchanged words plus struck words, struck runs as [-…-]
 *   status="inserted"  the AFTER text: unchanged words plus new words, new runs as [+…+]
 *
 * Only sentences that contain a change are shown. Struck words appear ONLY in the deleted
 * excerpt, so they can never be read as current law.
 *
 * Coverage. A bill that enacts a new section can have dozens of changed subsections. A subtree
 * that is entirely underlined is collapsed to ONE excerpt, and the section budget is shared
 * round-robin across top-level sections so amendments to existing law are not crowded out.
 */
import { answer } from './answer/index.js';
import { fleschKincaidGrade } from './answer/readability.js';
import { breadcrumb } from './chunk/index.js';
import { buildOutline } from './chip-summary.js';
import {
  appendNote,
  realHits,
  syntheticHit,
  withoutSyntheticChunks,
  type ChipDeps,
  type ChipRun,
  type RunChipOptions,
} from './chip-types.js';
import {
  walkSections,
  ZERO_USAGE,
  type ChipDefinition,
  type SearchHit,
  type ScanStatus,
  type Section,
  type Span,
} from './model/index.js';

/** Most changed sections (or collapsed new subtrees) shown to the model. The rest are counted. */
export const MAX_CHANGED_SECTIONS = 25;
/** Longest text per excerpt, so one huge repeal cannot crowd out the other sections. */
export const MAX_CHANGE_EXCERPT_CHARS = 3000;
/** Characters of a newly enacted section quoted as its opening. */
const NEW_SECTION_OPENING_CHARS = 300;

interface Piece {
  text: string;
  status: Span['status'];
  page?: number;
  line?: number;
}

/**
 * Split a section's spans into sentences. A boundary can only fall inside UNCHANGED text
 * (after ". ", "; " or ": "), so a struck or underlined run is never cut in half.
 */
function sentencesOf(spans: readonly Span[]): Piece[][] {
  const out: Piece[][] = [];
  let current: Piece[] = [];
  for (const span of spans) {
    if (span.text === '') continue;
    const parts =
      span.status === 'unchanged'
        ? span.text.split(/(?<=[.;:]\s)/)
        : [span.text];
    parts.forEach((text, i) => {
      current.push({
        text,
        status: span.status,
        ...(span.page !== undefined && { page: span.page }),
        // A line number belongs to where the span starts, not to its later parts.
        ...(i === 0 && span.line !== undefined && { line: span.line }),
      });
      if (span.status === 'unchanged' && /[.;:]\s$/.test(text)) {
        out.push(current);
        current = [];
      }
    });
  }
  out.push(current);
  return out.filter((s) => s.length > 0);
}

/** One sentence as BEFORE (`deleted`) or AFTER (`inserted`) text with the changed runs marked. */
function render(sentence: readonly Piece[], status: 'deleted' | 'inserted') {
  const [open, close] = status === 'deleted' ? ['[-', '-]'] : ['[+', '+]'];
  const other = status === 'deleted' ? 'inserted' : 'deleted';
  return (
    sentence
      .filter((p) => p.status !== other)
      .map((p) =>
        p.status === status ? `${open}${p.text.trim()}${close} ` : p.text,
      )
      .join('')
      .replace(/\s+/g, ' ')
      .replace(status === 'deleted' ? /-\]\s*\[-/g : /\+\]\s*\[\+/g, ' ')
      // No space between a marked run and punctuation that follows it.
      .replace(/(-\]|\+\])\s+(?=[.,;:])/g, '$1')
      .replace(/ (?=[.,;:]|\[(?:\+|-)[.,;:])/g, '')
      .trim()
  );
}

function capped(lines: readonly string[]): string {
  let text = '';
  for (const line of lines) {
    const next = text === '' ? line : `${text}\n${line}`;
    if (next.length > MAX_CHANGE_EXCERPT_CHARS) {
      return text === ''
        ? `${line.slice(0, MAX_CHANGE_EXCERPT_CHARS)}…`
        : `${text}\n…`;
    }
    text = next;
  }
  return text;
}

function locationOf(
  pieces: readonly Piece[],
  section: Section,
): Pick<SearchHit['chunk'], 'pageStart' | 'pageEnd' | 'lineStart' | 'lineEnd'> {
  const pages = pieces.flatMap((p) => (p.page === undefined ? [] : [p.page]));
  const pageStart = pages.length ? Math.min(...pages) : section.pageStart;
  const pageEnd = pages.length ? Math.max(...pages) : section.pageEnd;
  const lineStart = pieces.find((p) => p.line !== undefined)?.line;
  const lastLine = pieces.findLast((p) => p.line !== undefined)?.line;
  return {
    ...(pageStart !== undefined && { pageStart }),
    ...(pageEnd !== undefined && { pageEnd }),
    ...(lineStart !== undefined && { lineStart }),
    // A last line is only meaningful on the same page as the first.
    ...(lastLine !== undefined &&
      pageStart === pageEnd && { lineEnd: lastLine }),
  };
}

function leaf(path: readonly Section[]): Section {
  const section = path.at(-1);
  if (!section) throw new Error('empty section path');
  return section;
}

/** What a subtree contains: any new text, and any text that is not new. */
function contents(s: Section): { inserted: boolean; other: boolean } {
  let inserted = false;
  let other = false;
  for (const { spans } of walkSections([s])) {
    for (const span of spans) {
      if (span.text.trim() === '') continue;
      if (span.status === 'inserted') inserted = true;
      else other = true;
    }
  }
  return { inserted, other };
}

/** The excerpts for one section's own text, or none when it has no markup. */
function sentenceHits(
  docId: string,
  path: readonly Section[],
  key: string,
): SearchHit[] {
  const section = leaf(path);
  const sentences = sentencesOf(section.spans);
  const hits: SearchHit[] = [];
  for (const status of ['deleted', 'inserted'] as const) {
    const changed = sentences.filter((s) => s.some((p) => p.status === status));
    if (changed.length === 0) continue;
    hits.push(
      syntheticHit(docId, {
        key: `changes:${key}:${status}`,
        sectionId: section.id,
        breadcrumb: breadcrumb(path),
        text: capped(changed.map((s) => render(s, status))),
        amendmentStatus: status,
        location: locationOf(changed.flat(), section),
      }),
    );
  }
  return hits;
}

/** One excerpt for a subtree that is entirely new text. */
function newSectionHit(
  docId: string,
  path: readonly Section[],
  key: string,
): SearchHit {
  const section = leaf(path);
  const parts = [...walkSections([section])];
  const subdivisions = parts.length - 1;
  const pieces = parts.flatMap((s) => sentencesOf(s.spans).flat());
  const opening = pieces
    .map((p) => p.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NEW_SECTION_OPENING_CHARS);
  const size =
    subdivisions === 0
      ? ''
      : ` (${String(subdivisions)} ${subdivisions === 1 ? 'subdivision' : 'subdivisions'})`;
  const kind = path.length === 1 ? 'section' : 'division';
  const outline =
    subdivisions > 0 ? `\nOutline:\n${buildOutline(section).text}` : '';
  return syntheticHit(docId, {
    key: `changes:${key}:inserted`,
    sectionId: section.id,
    breadcrumb: breadcrumb(path),
    text: `Newly enacted: all of this ${kind}'s text is new${size}. It begins: [+${opening}+]${outline}`,
    amendmentStatus: 'inserted',
    location: locationOf(pieces, section),
  });
}

/** Changed entries under one top-level section, in document order. One entry = one section. */
function collect(
  docId: string,
  path: readonly Section[],
  counter: { n: number },
): SearchHit[][] {
  const section = leaf(path);
  const { inserted, other } = contents(section);
  if (inserted && !other) {
    return [[newSectionHit(docId, path, String(counter.n++))]];
  }
  const entries: SearchHit[][] = [];
  const own = sentenceHits(docId, path, String(counter.n));
  if (own.length > 0) {
    counter.n++;
    entries.push(own);
  }
  for (const child of section.children) {
    entries.push(...collect(docId, [...path, child], counter));
  }
  return entries;
}

/**
 * Pick up to `budget` entries, one from each top-level group in turn, then restore document
 * order. Returns the picks (flattened) and how many entries were left out.
 */
export function pickFairly(
  groups: readonly SearchHit[][][],
  budget: number,
): { picked: SearchHit[]; hidden: number } {
  const total = groups.reduce((n, g) => n + g.length, 0);
  const taken = groups.map(() => 0);
  let count = 0;
  for (let round = 0; count < budget && count < total; round++) {
    for (const [i, group] of groups.entries()) {
      if (count < budget && round < group.length) {
        taken[i] = round + 1;
        count++;
      }
    }
  }
  return {
    picked: groups.flatMap((g, i) => g.slice(0, taken[i]).flat()),
    hidden: total - count,
  };
}

/** True when some page's strike/underline marks were not read reliably. */
export function scanMarksUnreliable(scan: ScanStatus | undefined): boolean {
  return (scan?.pages ?? []).some((p) => p.marks !== 'read');
}

/**
 * True when some section carries a struck or underlined change that `runChangesChip` would
 * show. Reuses `collect`, so the two can never disagree about what counts as marked.
 */
export function hasAmendmentMarks(sections: readonly Section[]): boolean {
  const counter = { n: 0 };
  return sections.some((top) => collect('', [top], counter).length > 0);
}

const SCAN_CAVEAT =
  'Note: this document is a scan, and the strikethrough and underline marks on some pages were not read reliably, so this list of changes may be incomplete. Check the original pages.';

export async function runChangesChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
): Promise<ChipRun> {
  const counter = { n: 0 };
  const groups = deps.doc.sections
    .map((top) => collect(docId, [top], counter))
    .filter((g) => g.length > 0);
  const { picked, hidden } = pickFairly(groups, MAX_CHANGED_SECTIONS);
  const more =
    hidden > 0
      ? `${String(hidden)} more changed ${hidden === 1 ? 'section is' : 'sections are'} not covered here.`
      : '';

  // Unread marks look exactly like "nothing changed". Never let a doubtful scan say so: with
  // nothing to show, answer with the caveat alone; otherwise append it to what was found.
  const doubtful = scanMarksUnreliable(deps.doc.scan);
  if (doubtful && picked.length === 0) {
    options.onToken?.(SCAN_CAVEAT);
    return {
      answer: {
        text: SCAN_CAVEAT,
        citations: [],
        invalidCitations: [],
        warnings: [],
        declined: false,
        readingGrade: fleschKincaidGrade(SCAN_CAVEAT),
        provider: deps.provider.id,
        model: deps.provider.model,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      hits: [],
      backendUsage: ZERO_USAGE,
      mode: 'none',
    };
  }

  const result = await answer({
    provider: deps.provider,
    question: chip.label,
    context: { hits: picked, metadata: deps.doc.metadata },
    chipInstruction: chip.answerInstruction,
    signal: options.signal,
    onToken: options.onToken,
    maxTokens: options.maxTokens,
  });
  return {
    answer: appendNote(
      {
        ...result,
        citations: result.citations.map((c) =>
          withoutSyntheticChunks(c, docId),
        ),
      },
      doubtful ? `${more} ${SCAN_CAVEAT}`.trim() : more,
      options.onToken,
    ),
    // The excerpts are built for the prompt and have no stored chunk behind them.
    hits: realHits(picked, docId),
    backendUsage: ZERO_USAGE,
    mode: 'none',
  };
}
