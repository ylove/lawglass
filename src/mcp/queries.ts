/**
 * The read-only document queries behind both the MCP tools and the CLI's `--json` commands, so
 * one function produces one JSON shape for both. Nothing here fetches, calls a model or touches
 * the filesystem: it reads the cached `NormalizedDoc` and the retrieval index, and it takes doc
 * ids only (a label, URL or path is never resolved here).
 *
 * Everything quoted from the document goes through `UntrustedText` (see ./untrusted.ts).
 */
import { createHash } from 'node:crypto';
import { retrieve } from '../core/retrieve/index.js';
import {
  cleanQuestion,
  MAX_QUESTION_LENGTH,
} from '../core/pipeline/question.js';
import {
  findSectionPath,
  formatLocation,
  pathLabel,
  sectionExcerpt,
} from '../core/pipeline/index.js';
import type { Registry, RegistryEntry } from '../core/registry.js';
import {
  walkSections,
  type NormalizedDoc,
  type RetrievalBackend,
  type RetrievalMode,
  type Section,
  type SourceLocation,
  type Span,
} from '../core/model/index.js';
import { BRAND } from '../core/brand.js';
import { isLegendNotFoundWarning } from '../core/parse/change-marks.js';
import { notIngested, ToolError } from './errors.js';
import {
  billNumberShape,
  isShapedId,
  jurisdictionName,
  sectionHandles,
  levelNumberShape,
  sessionShape,
  subsectionNumShape,
  versionShape,
  type SectionHandles,
} from './shapes.js';
import type { UntrustedText } from './untrusted.js';

export interface QueryDeps {
  backend: RetrievalBackend;
  registry: Registry;
  retrievalMode: RetrievalMode;
  /** Lowers the response cap (tests only; the shipped cap is `HARD_CAP_TOKENS`). */
  capTokens?: number | undefined;
}

/**
 * Hard cap on one response. The estimate is conservative: ASCII costs a quarter token per
 * UTF-16 unit, anything else a whole token per unit (CJK and other scripts run near 1 or more).
 */
export const HARD_CAP_TOKENS = 8000;
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4 + other);
}

export const SEARCH_PAGE_SIZE = 5;
/** Deepest rank a cursor can reach; bounds how much one search asks the index for. */
export const SEARCH_MAX_RANK = 50;
export const HIT_MAX_WORDS = 120;
const OUTLINE_PAGE_LINES = 250;
const OUTLINE_HEADING_CHARS = 100;
/** Raw section text per page. Redline repeats the text three ways, so its page is smaller. */
const CURRENT_PAGE_CHARS = 8000;
const REDLINE_PAGE_CHARS = 3000;
const MAX_SEGMENT_CHARS = 1500;
/** Redline pages repeat per-segment markup, so many tiny segments are bounded by count too. */
const MAX_PAGE_SEGMENTS = 120;
const MAX_SECTION_INPUT_CHARS = 200;

/**
 * Nothing reads strike-through or underline from scanned pixels yet (#193), so say exactly that:
 * the words on scanned pages are OCR text, and struck or inserted words there were not detected.
 */
export const SCAN_WARNING =
  'Scanned document: the text comes from OCR and may contain errors; struck and inserted words on scanned pages were not detected. Check the original.';

/**
 * New York and New Jersey bills mark deleted wording with brackets, explained by a legend. When
 * core could not find the legend it leaves bracketed old law as unchanged text (and says so in
 * the document's warnings), so bracketed wording is unverified, not current.
 */
export const CHANGE_MARKS_WARNING =
  "The bill's change legend was not found, so bracketed wording could not be marked as removed. Bracketed deletions can run across sections, so any passage may include deleted old law; check the original.";

/** True when core warned that this bill's bracketed deletions could not be marked. */
export const legendMissing = (doc: Pick<NormalizedDoc, 'warnings'>): boolean =>
  doc.warnings.some(isLegendNotFoundWarning);

// ---------------------------------------------------------------------------------------------
// Doc ids, cursors, shared helpers
// ---------------------------------------------------------------------------------------------

/**
 * Resolves a doc id (64 hex, or a unique prefix of at least 8) to a full id of an ingested
 * document. Labels, URLs and paths are not accepted: the registry is only ever asked to compare
 * hex strings, and the id never reaches the filesystem unvalidated.
 */
export async function resolveDocId(
  registry: Registry,
  backendKind: RetrievalBackend['kind'],
  input: unknown,
): Promise<string> {
  const id = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{8,64}$/.test(id))
    throw new ToolError(
      'INVALID_INPUT',
      'doc must be a document id: 64 hex characters, or a unique prefix of at least 8. Get it from the ingest tool.',
    );
  // Documents on another backend can't be searched here; treat them as not ingested.
  const entries = (await registry.list()).filter(
    (entry: RegistryEntry) => entry.backend === backendKind,
  );
  const matches = entries.filter((entry) =>
    id.length === 64 ? entry.docId === id : entry.docId.startsWith(id),
  );
  if (matches.length > 1)
    throw new ToolError(
      'INVALID_INPUT',
      'That document id prefix is ambiguous. Use more characters.',
    );
  const [match] = matches;
  if (!match) throw notIngested();
  return match.docId;
}

/**
 * The largest count in [1, total] whose response fits under the cap. Size grows with the count,
 * so a binary search needs O(log n) serializations instead of one per dropped item. Always at
 * least 1 so a page makes progress.
 */
function fitCount(
  deps: QueryDeps,
  total: number,
  build: (count: number) => object,
): number {
  const cap = deps.capTokens ?? HARD_CAP_TOKENS;
  const fits = (count: number): boolean =>
    estimateTokens(JSON.stringify(build(count))) <= cap;
  let low = 1;
  let high = Math.max(total, 1);
  if (fits(high)) return high;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

const shortHash = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 8);

interface CursorBody {
  /** Offset into the result list. */
  o: number;
  /** Binds the cursor to its request, so a cursor can't be replayed against another query. */
  h: string;
}

function encodeCursor(offset: number, hash: string): string {
  return Buffer.from(
    JSON.stringify({ o: offset, h: hash } satisfies CursorBody),
  )
    .toString('base64url')
    .slice(0, 100);
}

function decodeCursor(cursor: unknown, hash: string, max: number): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  const invalid = new ToolError(
    'INVALID_INPUT',
    'cursor is not valid for this request. Use the cursor from the previous response unchanged.',
  );
  if (typeof cursor !== 'string' || cursor.length > 120) throw invalid;
  try {
    const body = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<CursorBody>;
    const offset = body.o;
    if (
      body.h !== hash ||
      typeof offset !== 'number' ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > max
    )
      throw invalid;
    return offset;
  } catch {
    throw invalid;
  }
}

async function loadDocument(
  deps: QueryDeps,
  docId: string,
): Promise<NormalizedDoc> {
  const doc = await deps.registry.getDocument(docId); // DOC_NOT_FOUND maps to NOT_INGESTED
  // Reading counts as use, so the document cap evicts a document nobody is using instead.
  await deps.registry.touch(docId).catch(() => undefined);
  return doc;
}

/**
 * "Ohio H.B. 62 (135th G.A., As Introduced)". Each part passes a strict shape check (see
 * ./shapes.ts) because this string sits outside the untrusted wrapper; a part that fails is
 * left out, and with no valid bill number the name is just "document <8 hex>". Titles and
 * registry labels are free text and never appear here.
 */
function documentName(doc: NormalizedDoc): string {
  const { metadata } = doc;
  const number = billNumberShape(metadata.billNumber);
  if (!number) return `document ${doc.docId.slice(0, 8)}`;
  const head = [jurisdictionName(metadata.jurisdiction), number]
    .filter(Boolean)
    .join(' ');
  const detail = [
    sessionShape(metadata.session),
    versionShape(metadata.version),
  ]
    .filter(Boolean)
    .join(', ');
  return detail ? `${head} (${detail})` : head;
}

/**
 * "Sec. 2901.09(B)", "Article 5", "Title II": core's own label (see `pathLabel`: the level is
 * named by its id prefix) applied only to printed numbers that pass a strict shape check, since
 * this string sits outside the untrusted wrapper. A level whose number fails the check is
 * "unnumbered part s<n>", which cannot be mistaken for a real section number.
 */
function sectionLabel(
  doc: NormalizedDoc,
  sectionId: string,
  handles: SectionHandles,
): string {
  const path = findSectionPath(doc.sections, sectionId);
  const unnumbered = `unnumbered part s${String(handles.ordinalOf(sectionId))}`;
  if (!path) return unnumbered;
  let start = path.length - 1;
  for (let i = path.length - 1; i >= 0; i--) {
    if ((path[i]?.id.split('/').at(-1) ?? '').startsWith('sec-')) {
      start = i;
      break;
    }
  }
  const [first, ...rest] = path.slice(start);
  const firstNum = levelNumberShape(first?.num);
  if (!first || !firstNum) return unnumbered;
  // Only shape-checked numbers go in; an enumerator that fails is dropped, never printed.
  const shaped: Section[] = [
    { ...first, num: firstNum },
    ...rest.flatMap((node) => {
      const num = subsectionNumShape(node.num);
      return num ? [{ ...node, num }] : [];
    }),
  ];
  return pathLabel(shaped);
}

function sectionRef(
  docId: string,
  sectionId: string,
  handles: SectionHandles,
): string {
  return `${BRAND.name}://doc/${docId.slice(0, 16)}/§${encodeURIComponent(handles.handleOf(sectionId))}`;
}

type Marks = 'read' | 'uncertain' | 'not-read';
const MARK_RANK: Record<Marks, number> = {
  read: 0,
  uncertain: 1,
  'not-read': 2,
};

/**
 * The worst strike-reading status among the SCANNED pages a passage covers. `scan.pages` lists
 * scanned pages only; a page that is not listed is native text and says nothing here.
 */
function marksFor(
  doc: NormalizedDoc,
  pages: readonly number[],
): Marks | undefined {
  if (!doc.scan) return undefined;
  let worst: Marks | undefined;
  for (const page of pages) {
    const value = doc.scan.pages.find((p) => p.page === page)?.marks;
    if (value && (!worst || MARK_RANK[value] > MARK_RANK[worst])) worst = value;
  }
  return worst;
}

/** True when the document has scanned pages at all (an empty list means a native PDF). */
const isScanned = (doc: NormalizedDoc): boolean =>
  (doc.scan?.pages.length ?? 0) > 0;

function pageRange(location: SourceLocation): number[] {
  const { pageStart, pageEnd = pageStart } = location;
  if (pageStart === undefined || pageEnd === undefined) return [];
  const pages: number[] = [];
  for (let page = pageStart; page <= Math.min(pageEnd, pageStart + 50); page++)
    pages.push(page);
  return pages;
}

function limitWords(text: string, max: number): { text: string; cut: boolean } {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return { text: text.trim(), cut: false };
  return { text: `${words.slice(0, max).join(' ')} …`, cut: true };
}

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

export interface SearchHitPayload {
  rank: number;
  cite: string;
  ref: string;
  section: string;
  /** `deleted` means the passage is struck text: not law. */
  status: 'unchanged' | 'inserted' | 'deleted' | 'unknown';
  heading?: string;
  /** The passage as current law. Empty for struck-only passages. */
  current_text: string;
  /** Present only for struck-only passages, which are never mixed into `current_text`. */
  struck_text?: string;
  text_truncated?: boolean;
  /** Scanned documents: how well strike marks were read on the passage's pages. */
  marks?: Marks;
}

export interface SearchPayload {
  notice: string;
  instruction_like_text: boolean;
  hidden_chars_removed?: number;
  doc: string;
  source_sha256: string;
  hits: SearchHitPayload[];
  /** Pass back unchanged for the next page; null when there are no more results. */
  cursor: string | null;
  /** True when more results exist beyond this page, or the size cap cut this page short. */
  truncated: boolean;
  scan_warning?: string;
  /** NY/NJ bills whose change legend was not found: bracketed text is unverified. */
  change_marks_warning?: string;
}

/**
 * The same hygiene as a question asked in the CLI or web UI (core `cleanQuestion`: the 500
 * character cap measured on the raw input, invisible characters removed), with a fixed error.
 */
function cleanSearchQuery(raw: unknown): string {
  try {
    return cleanQuestion(typeof raw === 'string' ? raw : '');
  } catch {
    throw new ToolError(
      'INVALID_INPUT',
      `query must be 1 to ${String(MAX_QUESTION_LENGTH)} characters.`,
    );
  }
}

export async function searchDocument(
  deps: QueryDeps,
  docId: string,
  args: { query: unknown; cursor?: unknown },
  w: UntrustedText,
  signal?: AbortSignal,
): Promise<SearchPayload> {
  const query = cleanSearchQuery(args.query);
  const hash = shortHash('search', docId, query);
  const offset = decodeCursor(
    args.cursor,
    hash,
    SEARCH_MAX_RANK - SEARCH_PAGE_SIZE,
  );
  const doc = await loadDocument(deps, docId);
  const handles = sectionHandles(doc);

  // One extra result tells us whether a next page exists.
  const topK = Math.min(SEARCH_MAX_RANK, offset + SEARCH_PAGE_SIZE + 1);
  const found = await retrieve(deps.backend, {
    docId,
    query,
    mode: deps.retrievalMode,
    topK,
    rerankTopN: topK,
    injectDefinitions: false,
    signal,
  });
  const ranked = found.hits.filter((hit) => !hit.injected);
  const page = ranked.slice(offset, offset + SEARCH_PAGE_SIZE);
  const moreBeyond =
    ranked.length > offset + SEARCH_PAGE_SIZE &&
    offset + SEARCH_PAGE_SIZE < SEARCH_MAX_RANK;

  const name = documentName(doc);
  const noLegend = legendMissing(doc);
  const hits: SearchHitPayload[] = page.map(({ chunk }, index) => {
    const label = sectionLabel(doc, chunk.sectionId, handles);
    const where = formatLocation(chunk);
    const struck = chunk.amendmentStatus === 'deleted';
    const { text, cut } = limitWords(chunk.text, HIT_MAX_WORDS);
    const marks = marksFor(doc, pageRange(chunk));
    return {
      rank: offset + index + 1,
      cite: [
        `${name} ${label}`,
        where,
        struck ? '[struck text, not current law]' : '[current text]',
      ]
        .filter(Boolean)
        .join(', ')
        .replace(', [', ' ['),
      ref: sectionRef(docId, chunk.sectionId, handles),
      section: handles.handleOf(chunk.sectionId),
      // "No changes" is unproven where strike marks were not read on a scanned page.
      // Likewise for every passage when the NY/NJ change legend was missing: a bracketed
      // deletion can run across passages, so none can be shown to lie outside one.
      status:
        chunk.amendmentStatus === 'unchanged' &&
        ((marks && marks !== 'read') || noLegend)
          ? 'unknown'
          : chunk.amendmentStatus,
      ...(chunk.heading ? { heading: w.wrap(chunk.heading) } : {}),
      current_text: struck ? '' : w.wrap(text),
      ...(struck ? { struck_text: w.wrap(text) } : {}),
      ...(cut ? { text_truncated: true } : {}),
      ...(marks ? { marks } : {}),
    };
  });

  // Hard cap: drop trailing hits until the response fits. They stay reachable via the cursor.
  const build = (n: number): Omit<SearchPayload, 'cursor' | 'truncated'> => ({
    ...w.envelope(),
    doc: docId,
    source_sha256: doc.docId,
    hits: hits.slice(0, n),
    ...(isScanned(doc) ? { scan_warning: SCAN_WARNING } : {}),
    ...(noLegend ? { change_marks_warning: CHANGE_MARKS_WARNING } : {}),
  });
  const kept = fitCount(deps, hits.length, build);
  const cutByCap = kept < hits.length;
  const more = moreBeyond || cutByCap;
  return {
    ...build(kept),
    cursor: more ? encodeCursor(offset + kept, hash) : null,
    truncated: more,
  };
}

// ---------------------------------------------------------------------------------------------
// get_section
// ---------------------------------------------------------------------------------------------

export type SectionView = 'current' | 'redline';

interface Segment {
  s: 'unchanged' | 'struck' | 'inserted';
  t: string;
}

const SEGMENT_STATUS: Record<Span['status'], Segment['s']> = {
  unchanged: 'unchanged',
  deleted: 'struck',
  inserted: 'inserted',
};

/** Merges neighbouring spans with the same status and drops empty ones. */
function toSegments(spans: readonly Span[]): Segment[] {
  const out: Segment[] = [];
  for (const span of spans) {
    if (span.text === '') continue;
    const s = SEGMENT_STATUS[span.status];
    const last = out.at(-1);
    if (last?.s === s) last.t += span.text;
    else out.push({ s, t: span.text });
  }
  return out;
}

/** Splits long segments at whitespace so one page never has to hold an unbounded run. */
function splitLong(segments: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    let rest = segment.t;
    while (rest.length > MAX_SEGMENT_CHARS) {
      const space = rest.lastIndexOf(' ', MAX_SEGMENT_CHARS);
      const cut = space > MAX_SEGMENT_CHARS / 2 ? space + 1 : MAX_SEGMENT_CHARS;
      out.push({ s: segment.s, t: rest.slice(0, cut) });
      rest = rest.slice(cut);
    }
    out.push({ s: segment.s, t: rest });
  }
  return out;
}

/**
 * Redline markers carry this response's random id. A document can't know it, so bracket-like
 * text in the bill (however it is drawn) can never pass for a marker.
 */
const MARKERS: Record<Segment['s'], (text: string, id: string) => string> = {
  unchanged: (text) => text,
  struck: (text, id) => `⟦STRUCK:${id}—NOT LAW: ${text}⟧`,
  inserted: (text, id) => `⟦INSERTED:${id}: ${text}⟧`,
};

/**
 * Finds a section by the handle the tools print, by its raw id, or by a printed number
 * ("2901.09") that names exactly one section. The input is only ever compared with ids in the
 * document tree; it never becomes a path.
 */
function findSectionId(
  doc: NormalizedDoc,
  handles: SectionHandles,
  input: unknown,
): string {
  const wanted = typeof input === 'string' ? input.trim() : '';
  if (
    wanted.length === 0 ||
    wanted.length > MAX_SECTION_INPUT_CHARS ||
    /[\s[\]]/.test(wanted)
  )
    throw new ToolError(
      'INVALID_INPUT',
      'section must be a section id from the outline or a search result.',
    );
  const viaHandle = handles.idOf(wanted);
  if (viaHandle) return viaHandle;
  const byNumber: string[] = [];
  for (const section of walkSections(doc.sections)) {
    if (section.id === wanted) return section.id;
    if (section.num?.toLowerCase() === wanted.toLowerCase())
      byNumber.push(section.id);
  }
  const [only] = byNumber;
  if (byNumber.length === 1 && only) return only;
  throw new ToolError(
    'INVALID_INPUT',
    byNumber.length > 1
      ? 'That section matches more than one section. Use an id from the outline.'
      : 'That section is not in this document. List ids with the outline tool.',
  );
}

export interface SectionPayload {
  notice: string;
  instruction_like_text: boolean;
  hidden_chars_removed?: number;
  doc: string;
  source_sha256: string;
  view: SectionView;
  section: string;
  ref: string;
  cite: string;
  heading?: string;
  /** `deleted` means the whole section is struck. */
  status: 'unchanged' | 'inserted' | 'mixed' | 'deleted' | 'unknown';
  /** True when scanned pages in this section had no strike-through reading (see scan_warning). */
  marks_not_read?: boolean;
  has_redline: boolean;
  current_text: string;
  /** Redline view only. */
  redline_note?: string;
  segments?: Segment[];
  /** Redline view only: the segments as one string with STRUCK / INSERTED markers carrying this response's id. */
  inline?: string;
  cursor: string | null;
  truncated: boolean;
  scan_warning?: string;
  change_marks_warning?: string;
  pages?: { page: number; marks: Marks }[];
}

function sectionStatus(spans: readonly Span[]): SectionPayload['status'] {
  const live = spans.filter((span) => span.text.trim() !== '');
  if (live.length > 0 && live.every((span) => span.status === 'deleted'))
    return 'deleted';
  const kinds = new Set(live.map((span) => span.status));
  if (kinds.has('deleted')) return 'mixed';
  return kinds.has('inserted') ? 'inserted' : 'unchanged';
}

export async function getSection(
  deps: QueryDeps,
  docId: string,
  args: { section: unknown; view?: unknown; cursor?: unknown },
  w: UntrustedText,
): Promise<SectionPayload> {
  const view = args.view ?? 'current';
  if (view !== 'current' && view !== 'redline')
    throw new ToolError(
      'INVALID_INPUT',
      'view must be "current" or "redline".',
    );
  const doc = await loadDocument(deps, docId);
  const handles = sectionHandles(doc);
  const sectionId = findSectionId(doc, handles, args.section);
  const excerpt = sectionExcerpt(doc, sectionId);
  const hash = shortHash('section', docId, sectionId, view);
  const offset = decodeCursor(args.cursor, hash, 1_000_000);

  const all = toSegments(excerpt.spans);
  const hasRedline = all.some((segment) => segment.s !== 'unchanged');
  // Current view: struck text is dropped and unchanged + inserted read as one stream.
  const stream = splitLong(
    view === 'redline'
      ? all
      : toSegments(
          excerpt.spans
            .filter((span) => span.status !== 'deleted')
            .map((span) => ({ ...span, status: 'unchanged' as const })),
        ),
  );

  // Page by raw size, always at least one segment, so a page is bounded and progress is certain.
  const budget = view === 'redline' ? REDLINE_PAGE_CHARS : CURRENT_PAGE_CHARS;
  let end = offset;
  let used = 0;
  while (end < stream.length) {
    const size = stream[end]?.t.length ?? 0;
    if (
      end > offset &&
      (used + size > budget || end - offset >= MAX_PAGE_SEGMENTS)
    )
      break;
    used += size;
    end++;
  }
  const page = stream.slice(offset, end);

  const name = documentName(doc);
  const label = sectionLabel(doc, sectionId, handles);
  const where = formatLocation(excerpt.location);
  const currentOf = (segments: readonly Segment[]): string =>
    segments
      .filter((segment) => segment.s !== 'struck')
      .map((segment) => segment.t)
      .join('');

  const cleaned = page.map((segment) => ({
    s: segment.s,
    t: w.clean(segment.t),
  }));
  const pageNumbers = [
    ...new Set(
      excerpt.spans.flatMap((span) =>
        span.page === undefined ? [] : [span.page],
      ),
    ),
  ].sort((a, b) => a - b);
  const pageMarks = pageNumbers.slice(0, 50).flatMap((n) => {
    const marks = marksFor(doc, [n]);
    return marks ? [{ page: n, marks }] : [];
  });
  const sectionMarks = marksFor(doc, pageNumbers);
  const marksNotRead = sectionMarks !== undefined && sectionMarks !== 'read';
  const noLegend = legendMissing(doc);
  const rawStatus = sectionStatus(excerpt.spans);
  const status =
    rawStatus === 'unchanged' && (marksNotRead || noLegend)
      ? 'unknown'
      : rawStatus;

  // Wrapped once, outside `body`, which runs again while the size cap shrinks the page.
  const heading = excerpt.heading ? w.wrap(excerpt.heading) : undefined;
  const body = (n: number): SectionPayload => {
    const shown = cleaned.slice(0, n);
    const next = offset + n < stream.length ? offset + n : null;
    return {
      ...w.envelope(),
      doc: docId,
      source_sha256: doc.docId,
      view,
      section: handles.handleOf(sectionId),
      ref: sectionRef(docId, sectionId, handles),
      cite: [
        `${name} ${label}`,
        where,
        view === 'redline'
          ? '[redline view: struck text is not law]'
          : '[current text]',
      ]
        .filter(Boolean)
        .join(', ')
        .replace(', [', ' ['),
      ...(heading ? { heading } : {}),
      status,
      ...(marksNotRead ? { marks_not_read: true } : {}),
      has_redline: hasRedline,
      current_text: w.enclose(currentOf(shown)),
      ...(view === 'redline'
        ? {
            redline_note: `Markers in inline carry the id ${w.suffix}. Bracketed text in the bill without that id is bill text, not a marker. segments[].s is authoritative.`,
            segments: shown.map((segment) => ({
              s: segment.s,
              t: w.enclose(segment.t),
            })),
            inline: w.enclose(
              shown
                .map((segment) => MARKERS[segment.s](segment.t, w.suffix))
                .join(''),
            ),
          }
        : {}),
      cursor: next === null ? null : encodeCursor(offset + n, hash),
      truncated: next !== null,
      ...(isScanned(doc)
        ? { scan_warning: SCAN_WARNING, pages: pageMarks }
        : {}),
      ...(noLegend ? { change_marks_warning: CHANGE_MARKS_WARNING } : {}),
    };
  };

  return body(fitCount(deps, cleaned.length, body));
}

// ---------------------------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------------------------

export interface OutlinePayload {
  notice: string;
  instruction_like_text: boolean;
  hidden_chars_removed?: number;
  doc: string;
  source_sha256: string;
  sections_total: number;
  /** One line per section, indented by depth: `<handle>  <number> <heading>`. */
  outline: string;
  cursor: string | null;
  truncated: boolean;
}

export async function outlineDocument(
  deps: QueryDeps,
  docId: string,
  args: { max_level?: unknown; cursor?: unknown },
  w: UntrustedText,
): Promise<OutlinePayload> {
  const maxLevel = args.max_level ?? 6;
  if (
    typeof maxLevel !== 'number' ||
    !Number.isInteger(maxLevel) ||
    maxLevel < 1
  )
    throw new ToolError(
      'INVALID_INPUT',
      'max_level must be a whole number of 1 or more.',
    );
  const doc = await loadDocument(deps, docId);
  const handles = sectionHandles(doc);
  const hash = shortHash('outline', docId, String(maxLevel));
  const offset = decodeCursor(args.cursor, hash, 10_000_000);

  const sections: Section[] = [...walkSections(doc.sections)].filter(
    (section) => section.level <= maxLevel,
  );
  // Only the lines on this page are cleaned, so text on other pages can't raise this page's flag.
  const lines = sections
    .slice(offset, offset + OUTLINE_PAGE_LINES)
    .map((section) => {
      const title = [section.num, section.heading]
        .filter(Boolean)
        .join(' ')
        .slice(0, OUTLINE_HEADING_CHARS);
      const indent = '  '.repeat(Math.min(section.level - 1, 6));
      // A section whose id is not number-shaped gets a handle; its real id stays in the quotes.
      const original = isShapedId(section.id)
        ? ''
        : ` (id: ${w.clean(section.id).slice(0, 80)})`;
      return `${indent}${handles.handleOf(section.id)}${original}  ${w.clean(title)}`.trimEnd();
    });

  const body = (n: number): OutlinePayload => {
    const next = offset + n < sections.length ? offset + n : null;
    return {
      ...w.envelope(),
      doc: docId,
      source_sha256: doc.docId,
      sections_total: sections.length,
      outline: w.enclose(lines.slice(0, n).join('\n')),
      cursor: next === null ? null : encodeCursor(offset + n, hash),
      truncated: next !== null,
    };
  };
  return body(fitCount(deps, lines.length, body));
}
