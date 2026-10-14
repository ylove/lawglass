import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { z } from 'zod';
import {
  AppError,
  EMPTY_METADATA,
  NormalizedDoc,
  type BillMetadata,
  type Definition,
  type ExternalRef,
  type Section,
  type Span,
  type SpanStatus,
} from '../model/index.js';

export interface XmlParseOptions {
  sourceUrl: string;
  /** Supplied by the fetch step so parsing is deterministic. */
  fetchedAt: string;
}

const context = z.object({ sourceUrl: z.url(), fetchedAt: z.iso.datetime() });

/** Real bills are ~6 MB with depth under 30; this only stops pathological nesting. */
const MAX_DEPTH = 256;

// ---------------------------------------------------------------------------
// Step 1: bytes -> a small element tree.
//
// Security: `saxes` is a pure tokenizer. It reads the DOCTYPE (govinfo files always have one
// pointing at "bill.dtd") but never fetches it, never loads external entities and never
// expands entities declared in an internal subset. A reference to any entity other than the
// five predefined ones is a well-formedness error, which we turn into PARSE_FAILED. That
// closes XXE and "billion laughs" attacks by construction rather than by configuration.
// ---------------------------------------------------------------------------

interface El {
  /** Local name: any namespace prefix is dropped (`dc:title` -> `title`). */
  name: string;
  attrs: Record<string, string>;
  /** Child elements and text nodes, in document order (needed for inline ins/del). */
  kids: (El | string)[];
}

function localName(name: string): string {
  return name.slice(name.indexOf(':') + 1);
}

function decodeBytes(bytes: Uint8Array): string {
  // The XML declaration is ASCII-compatible; read the declared encoding, default UTF-8.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const label =
    /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
  try {
    return new TextDecoder(label ?? 'utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AppError(
      'PARSE_FAILED',
      `The XML document is not valid ${label ?? 'UTF-8'} text.`,
      { cause },
    );
  }
}

function buildTree(text: string): El {
  // Plain mode (no namespace resolution): govinfo declares `xmlns:dc` and nothing else, and
  // generic documents may use undeclared prefixes. We match on local names ourselves.
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  let root: El | undefined;
  const stack: El[] = [];
  let failure: Error | undefined;
  parser.on('error', (error) => {
    failure ??= error;
  });
  parser.on('opentag', (tag) => {
    if (stack.length >= MAX_DEPTH) {
      failure ??= new Error(
        `XML is nested deeper than ${String(MAX_DEPTH)} levels.`,
      );
      return;
    }
    const el: El = {
      name: localName(tag.name),
      attrs: { ...tag.attributes },
      kids: [],
    };
    stack.at(-1)?.kids.push(el);
    root ??= el;
    stack.push(el);
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  const onText = (value: string) => {
    stack.at(-1)?.kids.push(value);
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  try {
    parser.write(text).close();
  } catch (cause) {
    failure ??= cause instanceof Error ? cause : new Error(String(cause));
  }
  if (failure || !root) {
    throw new AppError(
      'PARSE_FAILED',
      `The XML document is not well-formed: ${failure?.message ?? 'no root element'}`,
      { cause: failure },
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// Step 2: text and span helpers.
// ---------------------------------------------------------------------------

/** Amendment markup: `ins`/`del` (USLM, Akoma Ntoso) plus govinfo-style variants. */
const INSERTED = new Set(['ins', 'inserted', 'insert', 'addition']);
const DELETED = new Set(['del', 'deleted', 'delete', 'deletion', 'strike']);

/**
 * Elements that continue the surrounding sentence. Anything not listed is a block and gets a
 * space on both sides, so compact files (no whitespace between `</text><paragraph>`) don't
 * glue words together.
 */
const INLINE = new Set([
  'quote',
  'short-title',
  'term',
  'external-xref',
  'internal-xref',
  'committee-name',
  'header-in-text',
  'enum-in-header',
  'inline-comment',
  'target',
  'bold',
  'italic',
  'underline',
  'superscript',
  'subscript',
  'smallcap',
  'b',
  'i',
  'u',
  'em',
  'strong',
  'sup',
  'sub',
  'span',
  'a',
  'ref',
  'inline',
  'def',
  'date',
  'abbr',
  'q',
  'mref',
  'docTitle',
  'docNumber',
  'ins',
  'del',
  ...INSERTED,
  ...DELETED,
]);

/** Subtrees that never hold section text: tables of contents and document metadata. */
const SKIP = new Set([
  'toc',
  'toc-entry',
  'multi-column-toc-entry',
  'toc-quoted-entry',
  'metadata',
  'meta',
  'form',
  'notes',
  'note',
  // Boilerplate and signature blocks that are not law: "Be it enacted...", "Resolved," and
  // the Speaker/Vice President attestation on enrolled bills.
  'enacting-clause',
  'resolving-clause',
  'attestation-group',
  'attestation',
]);

/** Containers whose contents are quoted law being amended: flatten, never nest. */
const QUOTED = new Set([
  'quoted-block',
  'after-quoted-block',
  'quotedContent',
  'quotedText',
  'quotedStructure',
  'embeddedStructure',
]);

interface Run {
  text: string;
  status: SpanStatus;
  /** Raw runs (row breaks) are not whitespace-collapsed. */
  raw?: boolean;
  /** Quotation marks hug the quoted text: no space after an opening or before a closing one. */
  edge?: 'open' | 'close' | 'attach';
}

/** Collects runs in order; `plain` mirrors the non-deleted text for definition scope checks. */
class RunBuffer {
  runs: Run[] = [];

  add(text: string, status: SpanStatus, raw = false): void {
    if (text) this.runs.push(raw ? { text, status, raw } : { text, status });
  }

  /** Adds a quotation mark that hugs the text inside it. */
  addQuote(
    text: string,
    status: SpanStatus,
    edge: 'open' | 'close' | 'attach',
  ): void {
    this.runs.push({ text, status, edge });
  }

  get plain(): string {
    return this.runs
      .filter((run) => run.status !== 'deleted')
      .map((run) => run.text)
      .join('');
  }

  /** Collapses whitespace across run boundaries and merges neighbours with equal status. */
  toSpans(): Span[] {
    const out: Span[] = [];
    let atBreak = true; // output is empty or ends with a space/newline
    for (const run of this.runs) {
      let text: string;
      if (run.edge === 'close' || run.edge === 'attach') {
        const prev = out.at(-1);
        if (prev) prev.text = prev.text.replace(/ $/, '');
        text = run.text;
        // 'attach' glues what follows to the previous word (punctuation after a quote).
        atBreak = run.edge === 'attach';
      } else if (run.edge === 'open') {
        text = run.text;
        atBreak = true; // swallow the space that the quoted block's first child adds
      } else if (run.raw) {
        text = run.text;
        const last = out.at(-1);
        if (last) last.text = last.text.replace(/ $/, '');
        atBreak = true;
      } else {
        text = run.text.replace(/\s+/g, ' ');
        if (atBreak) text = text.replace(/^ /, '');
        if (!text) continue;
        atBreak = text.endsWith(' ');
      }
      const last = out.at(-1);
      if (last?.status === run.status) last.text += text;
      else out.push({ text, status: run.status });
    }
    // Trim the section's outer edges, then drop runs that became empty.
    const first = out[0];
    if (first) first.text = first.text.replace(/^[ \n]+/, '');
    const last = out.at(-1);
    if (last) last.text = last.text.replace(/[ \n]+$/, '');
    return out.filter((span) => span.text);
  }
}

function plainText(el: El | string): string {
  if (typeof el === 'string') return el.replace(/\s+/g, ' ');
  return el.kids.map(plainText).join('').replace(/\s+/g, ' ').trim();
}

function childrenNamed(el: El, name: string): El[] {
  return el.kids.filter(
    (k): k is El => typeof k !== 'string' && k.name === name,
  );
}

function findAll(el: El, name: string, out: El[] = []): El[] {
  for (const kid of el.kids) {
    if (typeof kid === 'string') continue;
    if (kid.name === name) out.push(kid);
    findAll(kid, name, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 3: dialects. A dialect says which elements are structural levels and where a level's
// number and heading live. Everything else is text belonging to the nearest level.
// ---------------------------------------------------------------------------

interface Dialect {
  name: 'bill' | 'uslm' | 'akn' | 'generic';
  numName: string;
  headingName: string;
  isLevel(el: El): boolean;
}

/** Large groupings: their ids are `<kind>-<num>` rather than a path below their parent. */
const CONTAINER_KINDS = new Set([
  'division',
  'title',
  'subtitle',
  'chapter',
  'subchapter',
  'part',
  'subpart',
  'book',
  'tome',
  'appropriations-major',
  'appropriations-intermediate',
  'appropriations-small',
]);

const BILL_LEVELS = new Set([
  ...CONTAINER_KINDS,
  'section',
  'subsection',
  'paragraph',
  'subparagraph',
  'clause',
  'subclause',
  'item',
  'subitem',
  'subsubitem',
]);

const BILL: Dialect = {
  name: 'bill',
  numName: 'enum',
  headingName: 'header',
  isLevel: (el) => BILL_LEVELS.has(el.name),
};

function genericDialect(name: 'uslm' | 'akn' | 'generic'): Dialect {
  return {
    name,
    numName: 'num',
    headingName: 'heading',
    // Fallback rule from the issue: an element with a num or heading child is a level.
    isLevel: (el) =>
      !SKIP.has(el.name) &&
      el.kids.some(
        (k) =>
          typeof k !== 'string' && (k.name === 'num' || k.name === 'heading'),
      ),
  };
}

/** Where a congressional document keeps its operative text. */
const BODY_NAMES = ['legis-body', 'resolution-body', 'amendment-body'];

function findBody(root: El): El | undefined {
  for (const name of BODY_NAMES) {
    const found = findAll(root, name)[0];
    if (found) return found;
  }
  return undefined;
}

const BILL_ROOTS = new Set([
  'bill',
  'resolution',
  'amendment-doc',
  'amendment',
]);

function detectDialect(root: El): Dialect | 'bill-no-body' {
  if (root.name === 'akomaNtoso') return genericDialect('akn');
  // Checked before `bill`: USLM bills use the same root name as congressional bill XML.
  if (/uslm/i.test(root.attrs.xmlns ?? '')) return genericDialect('uslm');
  if (BILL_ROOTS.has(root.name)) {
    return findBody(root) ? BILL : 'bill-no-body';
  }
  return genericDialect('generic');
}

// ---------------------------------------------------------------------------
// Step 4: the walk that builds sections, definitions and external references.
// ---------------------------------------------------------------------------

interface Frame {
  section: Section;
  kind: string;
  buffer: RunBuffer;
}

interface WalkState {
  dialect: Dialect;
  ids: Set<string>;
  definitions: Definition[];
  refs: Map<string, ExternalRef>;
}

/** Words printed before a number ("Section 1.", "Chapter I"); the id keeps only the number. */
const LABEL_PREFIX =
  /^(?:section|sec\.?|§|article|chapter|title|subtitle|part|subpart|division|subchapter)\s*(?=\S)/i;

const sanitize = (value: string) => value.replace(/[\s[\]/]+/g, '-');

/** "(a)" -> "a", "1." -> "1", "Section 4." -> "4". The printed form is kept in `num`. */
function idPiece(num: string | undefined, fallback: string): string {
  const inner = (num ?? '')
    .replace(LABEL_PREFIX, '')
    .replace(/^\((.*)\)$/, '$1')
    .replace(/\.$/, '');
  return sanitize(inner.trim()) || fallback;
}

/** Top-level numbers print as "Section 1." / "1."; deeper ones keep their parentheses. */
function printedNum(text: string, kind: string): string | undefined {
  let num = text.trim().replace(/\.$/, '');
  if (kind === 'section') num = num.replace(/^(?:section|sec\.?|§)\s*/i, '');
  return num || undefined;
}

function uniqueId(
  state: WalkState,
  preferred: string,
  qualified: string,
): string {
  let id = preferred;
  if (state.ids.has(id)) id = qualified;
  for (let n = 2; state.ids.has(id); n++) id = `${qualified}~${String(n)}`;
  state.ids.add(id);
  return id;
}

function statusOf(el: El, inherited: SpanStatus): SpanStatus {
  if (inherited === 'deleted' || DELETED.has(el.name)) return 'deleted';
  if (INSERTED.has(el.name)) return 'inserted';
  return inherited;
}

const DOCUMENT_SCOPE =
  /\b(?:in|for (?:the )?purposes? of|as used in) this (?:act|resolution)\b/i;
/** "In this section" and the narrower "for the purpose of this subsection". */
const LOCAL_SCOPE =
  /\b(?:in|for (?:the )?purposes? of|as used in) this (section|subsection|paragraph|subparagraph|clause|subclause)\b/i;
const DEFINING = /\b(?:means?|includes?|has the meaning|have the meanings?)\b/i;
/** A lead-in such as "The term eligible entity—" whose definition follows as subparagraphs. */
const OPEN_LEAD_IN = /[—:–]$|--$/;

/** Text of an element's own content (not struck text), whitespace-collapsed. */
function liveText(
  el: El,
  frames: Frame[],
  state: WalkState,
  extra: El[] = [],
): string {
  const buffer = new RunBuffer();
  collectInline(el, buffer, 'unchanged', frames, state, false);
  for (const more of extra)
    collectInline(more, buffer, 'unchanged', frames, state, false);
  return buffer
    .toSpans()
    .filter((span) => span.status !== 'deleted')
    .map((span) => span.text)
    .join('');
}

function addDefinitions(
  el: El,
  following: El[],
  frames: Frame[],
  state: WalkState,
  status: SpanStatus,
): void {
  const terms = childrenNamed(el, 'term').map(plainText).filter(Boolean);
  if (terms.length === 0 || status === 'deleted') return;
  const leadIn = liveText(el, frames, state);
  const verb = DEFINING.exec(leadIn);
  const open = OPEN_LEAD_IN.test(leadIn.trim());
  if (!verb && !open) return;
  // "The term X—" continues in the level's subparagraphs: (A), (B), ... are part of the
  // definition, so they are appended (injecting just "means—" would tell the model nothing).
  const text = open ? liveText(el, frames, state, following) : leadIn;
  const owner = frames.at(-1);
  if (!owner) return;
  let scope: Definition['scope'] = 'unknown';
  let scopeSectionId: string | undefined;
  // Nearest statement wins: the definition's own sentence ("As used in this Act, the term
  // ..."), then the intro text of each enclosing level, innermost first.
  for (let depth = frames.length; depth >= 0; depth--) {
    const plain =
      depth === frames.length ? leadIn : (frames[depth]?.buffer.plain ?? '');
    if (DOCUMENT_SCOPE.test(plain)) {
      scope = 'document';
      break;
    }
    const local = LOCAL_SCOPE.exec(plain)?.[1]?.toLowerCase();
    if (!local) continue;
    scope = 'section';
    // "This section" limits to the enclosing section; "this subsection/paragraph/..." to the
    // level whose intro text says so (the definition's own level for its own sentence).
    scopeSectionId =
      local === 'section'
        ? frames.slice(0, depth + 1).findLast((f) => f.kind === 'section')
            ?.section.id
        : frames[Math.min(depth, frames.length - 1)]?.section.id;
    break;
  }
  // Only terms before the defining verb are being defined: "The term foreign national has
  // the meaning given the term alien in ..." defines "foreign national", not "alien".
  const cutoff = verb?.index ?? Infinity;
  for (const term of new Set(terms)) {
    const at = leadIn.indexOf(term);
    if (at >= 0 && at > cutoff) continue;
    state.definitions.push({
      term,
      text,
      sectionId: owner.section.id,
      scope,
      ...(scope === 'section' && scopeSectionId ? { scopeSectionId } : {}),
    });
  }
}

/** Citation targets we can normalise; anything else keeps the printed text. */
/** Capture group of a regexp match; groups in our patterns are mandatory. */
const group = (match: RegExpExecArray, index: number) => match[index] ?? '';

function externalRef(
  el: El,
): { citation: string; kind: ExternalRef['kind'] } | undefined {
  const printed = plainText(el);
  if (el.name === 'external-xref') {
    const legalDoc = el.attrs['legal-doc'] ?? '';
    const cite = /^usc\/([^/]+)\/([^/]+)/.exec(el.attrs['parsable-cite'] ?? '');
    if (legalDoc === 'usc' && cite)
      return {
        citation: `${group(cite, 1)} U.S.C. ${group(cite, 2)}`,
        kind: 'us_code',
      };
    const law = /^public-law\/(\d+)\/(\d+)/.exec(
      el.attrs['parsable-cite'] ?? '',
    );
    if (law)
      return {
        citation: `Pub. L. ${group(law, 1)}-${group(law, 2)}`,
        kind: 'public_law',
      };
    if (!printed) return undefined;
    const kind = legalDoc === 'regulation' ? 'cfr' : 'other';
    return { citation: printed, kind };
  }
  // USLM `<ref href="/us/usc/t15/s632">`: only links into the U.S. Code or public laws.
  const href = el.attrs.href ?? '';
  const usc = /^\/us\/usc\/t(\d+[A-Za-z]?)\/s([^/]+)/.exec(href);
  if (usc)
    return {
      citation: `${group(usc, 1)} U.S.C. ${group(usc, 2)}`,
      kind: 'us_code',
    };
  const pl = /^\/us\/pl\/(\d+)\/(\d+)/.exec(href);
  if (pl)
    return {
      citation: `Pub. L. ${group(pl, 1)}-${group(pl, 2)}`,
      kind: 'public_law',
    };
  return undefined;
}

function noteRef(el: El, frames: Frame[], state: WalkState): void {
  const owner = frames.at(-1);
  const found = externalRef(el);
  if (!owner || !found) return;
  const key = `${found.kind}|${found.citation}`;
  const existing = state.refs.get(key);
  if (!existing) {
    state.refs.set(key, {
      text: plainText(el) || found.citation,
      citation: found.citation,
      kind: found.kind,
      sectionIds: [owner.section.id],
    });
  } else if (!existing.sectionIds.includes(owner.section.id)) {
    existing.sectionIds.push(owner.section.id);
  }
}

/**
 * Appends an element's text to a buffer. Used for a level's own text and for flattening
 * quoted law, where nested levels are printed inline (number, heading, text) rather than
 * becoming sections of this document.
 */
function collectInline(
  el: El,
  buffer: RunBuffer,
  inherited: SpanStatus,
  frames: Frame[],
  state: WalkState,
  noteRefs: boolean,
): void {
  const status = statusOf(el, inherited);
  const isBlock = !INLINE.has(el.name) && el.name !== 'linebreak';
  if (SKIP.has(el.name)) return;
  if (isBlock) buffer.add(' ', status);
  if (el.name === 'quote' && state.dialect.name === 'bill')
    buffer.add('“', status);
  // Mark where quoted law (text of another statute being amended) begins and ends, so an
  // answer can tell it from the bill's own provisions. `after-quoted-block` is the bill's
  // own trailing words (", as so amended."), not quoted.
  const quotedLaw = QUOTED.has(el.name) && el.name !== 'after-quoted-block';
  if (quotedLaw) buffer.addQuote('“', status, 'open');
  if (el.name === 'after-quoted-block') buffer.addQuote('', status, 'attach');
  if (noteRefs && (el.name === 'external-xref' || el.name === 'ref'))
    noteRef(el, frames, state);
  if (el.name === 'linebreak') buffer.add(' ', status);
  if (el.name === 'row') buffer.add('\n', status, true);
  let cells = 0;
  for (const kid of el.kids) {
    if (typeof kid === 'string') buffer.add(kid, status);
    else {
      // Cells of one table row are joined with " | " so columns stay distinguishable.
      if (el.name === 'row' && kid.name === 'entry' && cells++ > 0)
        buffer.add(' | ', status);
      collectInline(kid, buffer, status, frames, state, noteRefs);
    }
  }
  if (quotedLaw) buffer.addQuote('”', status, 'close');
  if (el.name === 'quote' && state.dialect.name === 'bill')
    buffer.add('”', status);
  if (isBlock) buffer.add(' ', status);
}

function walkLevel(
  el: El,
  frames: Frame[],
  state: WalkState,
  siblingIndex: number,
): Section {
  const { dialect } = state;
  const parent = frames.at(-1);
  const numEl = childrenNamed(el, dialect.numName)[0];
  const headingEl = childrenNamed(el, dialect.headingName)[0];
  const num = numEl ? printedNum(plainText(numEl), el.name) : undefined;
  const heading = headingEl ? plainText(headingEl) || undefined : undefined;
  // Headings-only levels (appropriations accounts) get a readable id from the heading
  // rather than their sibling position; uniqueId() separates repeats.
  const headingSlug = (heading ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const piece = idPiece(num, headingSlug || `n${String(siblingIndex)}`);

  const path = parent ? `${parent.section.id}/${piece}` : piece;
  const named =
    !parent || CONTAINER_KINDS.has(parent.kind) || el.name === 'section';
  const prefix = el.name === 'section' ? 'sec' : sanitize(el.name);
  const id = named
    ? uniqueId(
        state,
        `${prefix}-${piece}`,
        `${parent ? parent.section.id + '/' : ''}${prefix}-${piece}`,
      )
    : uniqueId(state, path, path);

  const section: Section = {
    id,
    ...(num !== undefined ? { num } : {}),
    ...(heading !== undefined ? { heading } : {}),
    level: frames.length + 1,
    spans: [],
    children: [],
  };
  const frame: Frame = { section, kind: el.name, buffer: new RunBuffer() };
  const inside = [...frames, frame];
  let childIndex = 0;

  for (const [at, kid] of el.kids.entries()) {
    if (typeof kid === 'string') {
      frame.buffer.add(kid, 'unchanged');
      continue;
    }
    if (kid === numEl || kid === headingEl || SKIP.has(kid.name)) continue;
    if (QUOTED.has(kid.name)) {
      collectInline(kid, frame.buffer, 'unchanged', inside, state, true);
    } else if (dialect.isLevel(kid)) {
      section.children.push(walkLevel(kid, inside, state, ++childIndex));
    } else {
      if (kid.name === 'text' || kid.name === 'p')
        addDefinitions(
          kid,
          el.kids
            .slice(at + 1)
            .filter(
              (k): k is El =>
                typeof k !== 'string' &&
                !SKIP.has(k.name) &&
                dialect.isLevel(k),
            ),
          inside,
          state,
          'unchanged',
        );
      collectInline(kid, frame.buffer, 'unchanged', inside, state, true);
    }
  }
  section.spans = frame.buffer.toSpans();
  return section;
}

// ---------------------------------------------------------------------------
// Step 5: metadata.
// ---------------------------------------------------------------------------

const firstText = (el: El | undefined, name: string): string | null => {
  if (!el) return null;
  const found = findAll(el, name)[0];
  return found ? plainText(found) || null : null;
};

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  one: 1,
};

/** "119th", "One Hundred Eighteenth" or "second" -> a number; undefined when not an ordinal. */
function ordinalNumber(text: string): number | undefined {
  const digits = /\b(\d+)(?:st|nd|rd|th)\b/i.exec(text)?.[1];
  if (digits) return Number(digits);
  let total = 0;
  let found = false;
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const value = ORDINAL_WORDS[word];
    if (value === undefined) continue;
    found = true;
    // "one hundred": the multiplier precedes "hundred".
    total = value === 100 ? Math.max(total, 1) * 100 : total + value;
  }
  return found ? total : undefined;
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${String(n)}${suffix}`;
}

/** Govinfo prints "One Hundred Eighteenth Congress of the United States of America". */
function sessionLabel(
  congress: string | null,
  session: string | null,
): string | null {
  const c = congress ? ordinalNumber(congress) : undefined;
  const sNumber = session ? ordinalNumber(session) : undefined;
  const parts = [
    congress ? (c ? `${ordinal(c)} Congress` : congress) : null,
    session ? (sNumber ? `${ordinal(sNumber)} Session` : session) : null,
  ];
  return parts.filter(Boolean).join(', ') || null;
}

/** "119 S202 IS: Short Title" -> "Short Title" (the Dublin Core title carries a file prefix). */
const DC_PREFIX = /^\s*(?:\d+\s+)?[A-Za-z]+\s*\d+\s+[A-Z]+:\s+/;

function billMetadata(root: El): BillMetadata {
  const form = findAll(root, 'form')[0];
  const sponsors = form
    ? [...findAll(form, 'sponsor'), ...findAll(form, 'cosponsor')]
    : [];
  // Document order, not "all sponsors then all cosponsors".
  const ordered = form ? orderByDocument(form, sponsors) : [];
  const stripped = firstText(findAll(root, 'metadata')[0], 'title')?.replace(
    DC_PREFIX,
    '',
  );
  const shortTitle = stripped === '' ? undefined : stripped;
  return {
    // The short title users know the bill by; the long official title is the fallback.
    title: shortTitle ?? firstText(form, 'official-title'),
    billNumber: firstText(form, 'legis-num'),
    jurisdiction: 'United States',
    session: sessionLabel(
      firstText(form, 'congress'),
      firstText(form, 'session'),
    ),
    version: root.attrs['bill-stage'] ?? root.attrs['resolution-stage'] ?? null,
    sponsors: ordered.length ? ordered.map(plainText).filter(Boolean) : null,
    source: 'structured',
  };
}

function orderByDocument(root: El, wanted: El[]): El[] {
  const set = new Set(wanted);
  const out: El[] = [];
  const visit = (el: El) => {
    for (const kid of el.kids) {
      if (typeof kid === 'string') continue;
      if (set.has(kid)) out.push(kid);
      visit(kid);
    }
  };
  visit(root);
  return out;
}

function genericMetadata(root: El): BillMetadata {
  const title =
    firstText(root, 'official-title') ??
    firstText(root, 'docTitle') ??
    firstText(findAll(root, 'meta')[0], 'title') ??
    firstText(findAll(root, 'metadata')[0], 'title');
  return title
    ? { ...EMPTY_METADATA, title, source: 'structured' }
    : { ...EMPTY_METADATA };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Parses congressional bill XML (govinfo bill DTD), USLM and Akoma Ntoso, with a generic
 * num/heading fallback for anything else. `ins`/`del` markup becomes `Span.status`.
 * Section ids are built from printed numbers ("sec-4/b/2"), never from XML `id` attributes.
 * Amended law inside `quoted-block` is kept as text of the section that quotes it.
 */
export function parseXml(
  input: string | Uint8Array,
  options: XmlParseOptions,
): NormalizedDoc {
  if (!context.safeParse(options).success) {
    throw new AppError(
      'INVALID_INPUT',
      'Invalid XML document source or fetch timestamp.',
    );
  }
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const text = typeof input === 'string' ? input : decodeBytes(bytes);
  const root = buildTree(text);

  const detected = detectDialect(root);
  const warnings: string[] = [];
  let dialect: Dialect;
  if (detected === 'bill-no-body') {
    dialect = genericDialect('generic');
    warnings.push(
      'Congressional bill XML without a legis-body; parsed using generic num/heading rules.',
    );
  } else {
    dialect = detected;
    if (dialect.name === 'akn')
      warnings.push(
        'Akoma Ntoso detected; parsed using generic num/heading rules.',
      );
    if (dialect.name === 'generic')
      warnings.push(
        'Unrecognized XML schema; parsed using generic num/heading rules.',
      );
  }

  const state: WalkState = {
    dialect,
    ids: new Set(),
    definitions: [],
    refs: new Map(),
  };
  // Bills only have structure inside legis-body; elsewhere (form, metadata) is not body text.
  const isBill = dialect.name === 'bill';
  const scope = isBill ? (findBody(root) ?? root) : root;
  let sections: Section[] = [];
  let top = 0;
  // Bills only: text that sits outside any level (a resolution's "Whereas" preamble, loose
  // body text) is kept as a `preamble` section instead of being dropped.
  const front = new RunBuffer();
  const holdsLevel = (el: El): boolean =>
    el.kids.some(
      (k) =>
        typeof k !== 'string' &&
        !SKIP.has(k.name) &&
        !QUOTED.has(k.name) &&
        (dialect.isLevel(k) || holdsLevel(k)),
    );
  const collect = (el: El): void => {
    for (const kid of el.kids) {
      if (typeof kid === 'string' || SKIP.has(kid.name)) continue;
      if (dialect.isLevel(kid)) sections.push(walkLevel(kid, [], state, ++top));
      else if (!isBill || holdsLevel(kid)) collect(kid);
      else collectInline(kid, front, 'unchanged', [], state, false);
    }
  };
  if (isBill && scope !== root)
    for (const kid of root.kids)
      if (typeof kid !== 'string' && kid.name === 'preamble')
        collectInline(kid, front, 'unchanged', [], state, false);
  if (dialect.isLevel(scope) && scope !== root) {
    sections.push(walkLevel(scope, [], state, ++top));
  } else {
    collect(scope);
  }

  const frontSpans = front.toSpans();
  if (frontSpans.length > 0)
    sections.unshift({
      id: uniqueId(state, 'preamble', 'preamble'),
      level: 1,
      spans: frontSpans,
      children: [],
    });

  if (sections.length === 0) {
    // No recognizable structure: keep the text so the document is still searchable.
    const buffer = new RunBuffer();
    collectInline(root, buffer, 'unchanged', [], state, false);
    const spans = buffer.toSpans();
    if (spans.length === 0)
      throw new AppError('PARSE_FAILED', 'The XML document contains no text.');
    sections = [{ id: 'doc', level: 1, spans, children: [] }];
    warnings.push(
      'No sections found in the XML; the whole text is one section.',
    );
  }

  return NormalizedDoc.parse({
    docId: createHash('sha256').update(bytes).digest('hex'),
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt,
    format: 'xml',
    metadata:
      dialect.name === 'bill' ? billMetadata(root) : genericMetadata(root),
    sections,
    definitions: state.definitions,
    externalRefs: [...state.refs.values()],
    warnings,
  });
}
