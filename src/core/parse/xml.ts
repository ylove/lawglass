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
}

/** Collects runs in order; `plain` mirrors the non-deleted text for definition scope checks. */
class RunBuffer {
  runs: Run[] = [];

  add(text: string, status: SpanStatus, raw = false): void {
    if (text) this.runs.push(raw ? { text, status, raw } : { text, status });
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
      if (run.raw) {
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

function detectDialect(root: El): Dialect | 'bill-no-body' {
  if (root.name === 'akomaNtoso') return genericDialect('akn');
  // Checked before `bill`: USLM bills use the same root name as congressional bill XML.
  if (/uslm/i.test(root.attrs.xmlns ?? '')) return genericDialect('uslm');
  if (root.name === 'bill' || root.name === 'resolution') {
    return findAll(root, 'legis-body').length > 0 ? BILL : 'bill-no-body';
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
  /\b(?:in|for purposes? of|as used in) this (?:act|resolution)\b/i;
const SECTION_SCOPE = /\b(?:in|for purposes? of|as used in) this section\b/i;
const DEFINING = /\b(?:means?|includes?|has the meaning|have the meanings?)\b/i;

function addDefinitions(
  el: El,
  frames: Frame[],
  state: WalkState,
  status: SpanStatus,
): void {
  const terms = childrenNamed(el, 'term').map(plainText).filter(Boolean);
  if (terms.length === 0 || status === 'deleted') return;
  // Own text of this element only, minus struck text.
  const buffer = new RunBuffer();
  collectInline(el, buffer, 'unchanged', frames, state, false);
  const text = buffer
    .toSpans()
    .filter((span) => span.status !== 'deleted')
    .map((span) => span.text)
    .join('');
  if (!DEFINING.test(text)) return;
  const owner = frames.at(-1);
  if (!owner) return;
  let scope: Definition['scope'] = 'unknown';
  let scopeSectionId: string | undefined;
  // Nearest statement wins: the definition's own sentence ("As used in this Act, the term
  // ..."), then the intro text of each enclosing level, innermost first.
  for (let depth = frames.length; depth >= 0; depth--) {
    const plain =
      depth === frames.length ? text : (frames[depth]?.buffer.plain ?? '');
    const kind = DOCUMENT_SCOPE.test(plain)
      ? 'document'
      : SECTION_SCOPE.test(plain)
        ? 'section'
        : undefined;
    if (!kind) continue;
    scope = kind;
    if (kind === 'section')
      scopeSectionId = frames
        .slice(0, depth + 1)
        .findLast((f) => f.kind === 'section')?.section.id;
    break;
  }
  for (const term of new Set(terms)) {
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
  const piece = idPiece(num, `n${String(siblingIndex)}`);

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

  for (const kid of el.kids) {
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
        addDefinitions(kid, inside, state, 'unchanged');
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

function billMetadata(root: El): BillMetadata {
  const form = findAll(root, 'form')[0];
  const congress = firstText(form, 'congress');
  const session = firstText(form, 'session');
  const sponsors = form
    ? [...findAll(form, 'sponsor'), ...findAll(form, 'cosponsor')]
    : [];
  // Document order, not "all sponsors then all cosponsors".
  const ordered = form ? orderByDocument(form, sponsors) : [];
  const title =
    firstText(form, 'official-title') ??
    // Dublin Core `dc:title`; scoped to <metadata> so a `<title>` division can't match.
    firstText(findAll(root, 'metadata')[0], 'title');
  return {
    title,
    billNumber: firstText(form, 'legis-num'),
    jurisdiction: 'United States',
    session: [congress, session].filter(Boolean).join(', ') || null,
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
  const scope =
    dialect.name === 'bill' ? (findAll(root, 'legis-body')[0] ?? root) : root;
  let sections: Section[] = [];
  let top = 0;
  const collect = (el: El): void => {
    for (const kid of el.kids) {
      if (typeof kid === 'string' || SKIP.has(kid.name)) continue;
      if (dialect.isLevel(kid)) sections.push(walkLevel(kid, [], state, ++top));
      else collect(kid);
    }
  };
  if (dialect.isLevel(scope) && scope !== root) {
    sections.push(walkLevel(scope, [], state, ++top));
  } else {
    collect(scope);
  }

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
