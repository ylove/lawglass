import { createHash } from 'node:crypto';
import { load, type CheerioAPI } from 'cheerio';
import { z } from 'zod';
import {
  AppError,
  EMPTY_METADATA,
  NormalizedDoc,
  type Section,
  type Span,
  walkSections,
  type SpanStatus,
} from '../model/index.js';
import { detectSections } from './sections.js';
import type { TextParseOptions } from './text.js';

export type HtmlParseOptions = TextParseOptions & {
  /** HTTP `Content-Type` header value, when the fetch layer has one. Its charset wins over `<meta>`. */
  contentType?: string;
};

// domhandler is cheerio's own dependency; derive its node types rather than depend on it.
type AnyNode = ReturnType<CheerioAPI['root']>[number]['children'][number];
type Element = Extract<AnyNode, { attribs: Record<string, string> }>;

const context = z.object({ sourceUrl: z.url(), fetchedAt: z.iso.datetime() });

/** Never legislation text. `<style>` is read for class rules, then removed. */
const NOISE_SELECTOR = 'script, noscript, template, head';
/**
 * Page-level chrome. State pages put the bill's own title block and effective-date section in
 * `<header>`/`<footer>` inside `<article>`/`<main>`, so only those outside such a container go.
 */
const CHROME_SELECTOR = 'nav, header, footer';
const CONTENT_CONTAINER = 'article, main';
/** Sidebars and content hidden from readers: retrieval noise, removed wherever they sit. */
const HIDDEN_SELECTOR = 'aside, [hidden], [aria-hidden="true"]';
const DISPLAY_NONE = /(?:^|;)\s*display\s*:\s*none\b/i;
/** Removed text that looks like this is probably bill content: say so instead of dropping it silently. */
const SECTION_LIKE = /(?:\bsec(?:tion|\.)?|§)\s*\d/i;

const BLOCK_TAGS = new Set(
  (
    'address article aside blockquote body dd details div dl dt fieldset figcaption figure ' +
    'form h1 h2 h3 h4 h5 h6 hr html li main ol p pre section table tbody tfoot thead tr ul'
  ).split(' '),
);
const CELL_TAGS = new Set(['td', 'th']);

const TAG_STATUS: Record<string, SpanStatus> = {
  s: 'deleted',
  strike: 'deleted',
  del: 'deleted',
  u: 'inserted',
  ins: 'inserted',
};

/** What a `text-decoration` declaration says; `undefined` means it does not decide. */
type Decoration = SpanStatus | undefined;

function decorationFromValue(value: string): Decoration {
  const v = value.toLowerCase();
  // A strike wins over an underline on the same element: struck text is gone either way.
  if (v.includes('line-through')) return 'deleted';
  if (v.includes('underline')) return 'inserted';
  if (/\bnone\b/.test(v)) return 'unchanged';
  return undefined;
}

/** Last `text-decoration` / `text-decoration-line` declaration in a CSS declaration list. */
function decorationFromDeclarations(css: string): Decoration {
  let result: Decoration;
  for (const declaration of css.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    if (name !== 'text-decoration' && name !== 'text-decoration-line') continue;
    const decided = decorationFromValue(
      declaration.slice(colon + 1).replace(/!important/i, ''),
    );
    if (decided) result = decided;
  }
  return result;
}

interface ClassRule {
  tag?: string;
  className: string;
  status: SpanStatus;
}

/**
 * At-rules are handled conservatively: the contents of `@media screen` / `@media all` (the
 * rendering a reader sees) are kept as ordinary rules; every other at-rule (`@media print`,
 * `@supports`, `@page`, `@font-face`, ...) is ignored, so a print-only style never marks text.
 */
function flattenAtRules(css: string): string {
  let out = '';
  let at = 0;
  while (at < css.length) {
    const start = css.indexOf('@', at);
    if (start < 0) return out + css.slice(at);
    out += css.slice(at, start);
    const open = css.indexOf('{', start);
    const semi = css.indexOf(';', start);
    if (open < 0 || (semi >= 0 && semi < open)) {
      // Statement at-rule (`@import ...;`): nothing to read.
      at = semi < 0 ? css.length : semi + 1;
      continue;
    }
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}' && --depth === 0) break;
    }
    const prelude = css.slice(start, open).trim().toLowerCase();
    if (/^@media\s+(?:only\s+)?(?:screen|all)\s*$/.test(prelude))
      out += flattenAtRules(css.slice(open + 1, end));
    at = end + 1;
  }
  return out;
}

/**
 * Only `.class` and `tag.class` selectors are understood: amendment markup is applied through
 * classes. Tag-only rules (e.g. `a { text-decoration: underline }`) are ignored on purpose, or
 * every link would read as inserted text.
 */
function readClassRules(css: string): ClassRule[] {
  const rules: ClassRule[] = [];
  const stripped = flattenAtRules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  for (const [, selectors = '', body = ''] of stripped.matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    const status = decorationFromDeclarations(body);
    if (!status) continue;
    for (const selector of selectors.split(',')) {
      const match = /^\s*([a-z][a-z0-9]*)?\.([\w-]+)\s*$/i.exec(selector);
      if (!match?.[2]) continue;
      rules.push({
        ...(match[1] ? { tag: match[1].toLowerCase() } : {}),
        className: match[2],
        status,
      });
    }
  }
  return rules;
}

/** Headings and links are underlined by site styling; a class rule never makes them amendments. */
const STYLED_NOT_AMENDED = /^(?:h[1-6]|a)$/;

/** Inline style beats stylesheet classes, which beat the tag's own meaning. */
function ownStatus(element: Element, rules: readonly ClassRule[]): Decoration {
  const inline = decorationFromDeclarations(element.attribs.style ?? '');
  if (inline) return inline;
  const classes = new Set((element.attribs.class ?? '').split(/\s+/));
  const name = element.name.toLowerCase();
  let fromClass: Decoration;
  for (const rule of STYLED_NOT_AMENDED.test(name) ? [] : rules) {
    if (classes.has(rule.className) && (!rule.tag || rule.tag === name))
      fromClass = rule.status;
  }
  return fromClass ?? TAG_STATUS[name];
}

/** Text decorations propagate to descendants, so a strike anywhere above wins. */
function combine(inherited: SpanStatus, own: Decoration): SpanStatus {
  if (inherited === 'deleted' || own === 'deleted') return 'deleted';
  if (inherited === 'inserted' || own === 'inserted') return 'inserted';
  return 'unchanged';
}

interface Chunk {
  text: string;
  status: SpanStatus;
}

/** Collects flowed text into lines of status-tagged chunks. */
class LineBuilder {
  readonly lines: Chunk[][] = [];
  private current: Chunk[] = [];

  private atLineStart(): boolean {
    return this.current.length === 0;
  }

  private endsWithSpace(): boolean {
    return /\s$/.test(this.current.at(-1)?.text ?? '');
  }

  /** Normal flow: runs of whitespace collapse to one space, none at the line edges. */
  addFlowed(text: string, status: SpanStatus): void {
    let collapsed = text.replace(/\s+/g, ' ');
    if (this.atLineStart() || this.endsWithSpace())
      collapsed = collapsed.replace(/^ /, '');
    if (collapsed) this.current.push({ text: collapsed, status });
  }

  /** `<pre>`: spacing and newlines are content. */
  addPreformatted(text: string, status: SpanStatus): void {
    const rows = text.replace(/\r\n?/g, '\n').split('\n');
    for (const [index, row] of rows.entries()) {
      if (index > 0) this.endLine(true);
      if (row) this.current.push({ text: row, status });
    }
  }

  /** Close the current line. Block boundaries drop empty lines; `<pre>` keeps them. */
  endLine(keepEmpty = false): void {
    const line = this.current;
    this.current = [];
    // Trailing whitespace is never meaningful and would defeat marker/heading checks.
    for (let last = line.at(-1); last; last = line.at(-1)) {
      const trimmed = last.text.trimEnd();
      if (trimmed) {
        last.text = trimmed;
        break;
      }
      line.pop();
    }
    if (line.length > 0 || keepEmpty) this.lines.push(line);
  }
}

function walk(
  node: AnyNode,
  builder: LineBuilder,
  rules: readonly ClassRule[],
  status: SpanStatus,
  pre: boolean,
): void {
  // domhandler's ElementType is an enum; compare as plain strings.
  const type: string = node.type;
  if (type === 'text' && 'data' in node) {
    if (pre) builder.addPreformatted(node.data, status);
    else builder.addFlowed(node.data, status);
    return;
  }
  if (type !== 'tag' || !('attribs' in node)) return;
  const name = node.name.toLowerCase();
  if (name === 'br') {
    builder.endLine(true);
    return;
  }
  const block = BLOCK_TAGS.has(name);
  if (block) builder.endLine();
  if (CELL_TAGS.has(name)) builder.addFlowed(' ', status);
  const childStatus = combine(status, ownStatus(node, rules));
  const childPre = pre || name === 'pre';
  for (const child of node.children)
    walk(child, builder, rules, childStatus, childPre);
  if (block) builder.endLine();
}

/** Re-attach per-character amendment status to spans that detectSections produced. */
function applyStatuses(
  sections: Section[],
  statuses: readonly SpanStatus[],
  text: string,
): boolean {
  let cursor = 0;
  const state = { aligned: true };
  const visit = (section: Section): void => {
    const spans: Span[] = [];
    for (const span of section.spans) {
      const end = cursor + span.text.length;
      if (text.slice(cursor, end) !== span.text) state.aligned = false;
      // Split on status changes.
      let runStart = cursor;
      for (let at = cursor; at <= end; at++) {
        if (at < end && statuses[at] === statuses[runStart]) continue;
        spans.push({
          ...span,
          text: span.text.slice(runStart - cursor, at - cursor),
          status: statuses[runStart] ?? 'unchanged',
        });
        runStart = at;
      }
      cursor = end;
    }
    section.spans = spans.filter((span) => span.text !== '');
    for (const child of section.children) visit(child);
  };
  for (const section of sections) visit(section);
  return state.aligned && cursor === text.length;
}

function charsetOf(value: string | undefined): string | undefined {
  return /charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(value ?? '')?.[1];
}

/** WHATWG "extract a character encoding from a meta element" for an `http-equiv` content value. */
function charsetFromContent(content: string): string | undefined {
  const match =
    /charset[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r ;]*))/i.exec(
      content,
    );
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  return value === '' ? undefined : value;
}

const SPACE = /[\t\n\f\r ]/;

/** WHATWG "get an attribute": names are lowercased, the first of a duplicated name wins. */
function readAttributes(
  text: string,
  start: number,
): { attrs: Map<string, string>; end: number } {
  const attrs = new Map<string, string>();
  let at = start;
  while (at < text.length) {
    while (
      at < text.length &&
      (SPACE.test(text.charAt(at)) || text[at] === '/')
    )
      at++;
    if (at >= text.length || text[at] === '>') break;
    const nameStart = at;
    while (
      at < text.length &&
      !SPACE.test(text.charAt(at)) &&
      !'/>='.includes(text.charAt(at))
    )
      at++;
    const name = text.slice(nameStart, at).toLowerCase();
    while (at < text.length && SPACE.test(text.charAt(at))) at++;
    let value = '';
    if (text[at] === '=') {
      at++;
      while (at < text.length && SPACE.test(text.charAt(at))) at++;
      const quote = text[at];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, at + 1);
        const stop = close < 0 ? text.length : close;
        value = text.slice(at + 1, stop);
        at = stop + 1;
      } else {
        const valueStart = at;
        while (
          at < text.length &&
          !SPACE.test(text.charAt(at)) &&
          text[at] !== '>'
        )
          at++;
        value = text.slice(valueStart, at);
      }
    }
    if (name && !attrs.has(name)) attrs.set(name, value);
  }
  return { attrs, end: at };
}

/**
 * Minimal WHATWG "prescan a byte stream to determine its encoding" over the bytes read as
 * latin1 (a lossless byte-to-char map). Comments, `<script>`/`<style>` bodies and every tag
 * other than `<meta>` are skipped, so only a real `<meta charset>` or
 * `<meta http-equiv="content-type" content="...charset=...">` can declare the encoding.
 * (The spec itself would also look inside script text; skipping it is stricter on purpose.)
 */
function prescanCharset(bytes: Uint8Array): string | undefined {
  const text = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt < 0) return undefined;
    at = lt;
    if (text.startsWith('<!--', at)) {
      const close = text.indexOf('-->', at + 2);
      if (close < 0) return undefined;
      at = close + 3;
      continue;
    }
    const tag = /^<(\/?)([a-z][^\t\n\f\r />]*)/i.exec(text.slice(at, at + 64));
    if (!tag) {
      // `<!doctype>`, `<?pi>`, `</ >` and stray `<` are skipped.
      const gt = /^<[!?/]/.test(text.slice(at, at + 2))
        ? text.indexOf('>', at)
        : at;
      if (gt < 0) return undefined;
      at = gt + 1;
      continue;
    }
    const name = (tag[2] ?? '').toLowerCase();
    const { attrs, end } = readAttributes(text, at + tag[0].length);
    at = end + 1;
    if (tag[1]) continue;
    if (name === 'script' || name === 'style') {
      const close = text.toLowerCase().indexOf(`</${name}`, at);
      if (close < 0) return undefined;
      at = close;
      continue;
    }
    if (name !== 'meta') continue;
    const charset = attrs.get('charset');
    if (charset !== undefined) return charset.trim() || undefined;
    const content = attrs.get('content');
    if (attrs.get('http-equiv')?.toLowerCase() === 'content-type' && content) {
      const declared = charsetFromContent(content);
      if (declared) return declared;
    }
  }
  return undefined;
}

/**
 * Decode with the declared charset: BOM, then the HTTP `Content-Type` charset, then the
 * `<meta>` prescan. With no declaration the bytes must be valid UTF-8. An unknown label is an
 * error, never a silent guess. A meta-declared UTF-16/32 is read as UTF-8 (WHATWG: the page
 * is evidently ASCII-compatible). Safety net for a wrong meta label: if the label is not
 * UTF-8 but the bytes are valid UTF-8 with multibyte sequences, trust the bytes and warn.
 */
function decodeHtml(
  bytes: Uint8Array,
  options: HtmlParseOptions,
): { html: string; warnings: string[] } {
  const warnings: string[] = [];
  let label: string | undefined;
  let fromMeta = false;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    label = 'utf-8';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  else {
    label = charsetOf(options.contentType);
    if (!label) {
      label = prescanCharset(bytes);
      fromMeta = label !== undefined;
      if (label && /^utf-?(?:16|32)/i.test(label)) label = 'utf-8';
    }
  }
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder(label ?? 'utf-8', { fatal: true });
  } catch (cause) {
    throw new AppError(
      'PARSE_FAILED',
      `The HTML document declares an unsupported charset: ${label ?? 'unknown'}.`,
      { cause },
    );
  }
  if (
    fromMeta &&
    decoder.encoding !== 'utf-8' &&
    bytes.some((b) => b >= 0x80)
  ) {
    try {
      const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      warnings.push(
        `The HTML document declares charset ${label ?? ''} but its bytes are valid UTF-8; decoded as UTF-8.`,
      );
      return { html, warnings };
    } catch {
      // Not UTF-8 after all: the declaration is plausible.
    }
  }
  try {
    return { html: decoder.decode(bytes), warnings };
  } catch (cause) {
    throw new AppError(
      'PARSE_FAILED',
      `The HTML document is not valid ${decoder.encoding}.`,
      { cause },
    );
  }
}

function isInside(node: AnyNode, removed: ReadonlySet<AnyNode>): boolean {
  for (let up = node.parent; up; up = up.parent)
    if (removed.has(up)) return true;
  return false;
}

/** Strip non-content elements; returns a warning for each removal that looks like bill text. */
function removeNoise($: CheerioAPI): string[] {
  const warnings: string[] = [];
  const removable = [
    ...$(CHROME_SELECTOR)
      .toArray()
      .filter((el) => $(el).closest(CONTENT_CONTAINER).length === 0),
    ...$(HIDDEN_SELECTOR).toArray(),
    ...$('[style]')
      .toArray()
      .filter((el) => DISPLAY_NONE.test(el.attribs.style ?? '')),
  ];
  const removed = new Set<AnyNode>(removable);
  for (const el of removable) {
    if (isInside(el, removed)) continue;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (SECTION_LIKE.test(text))
      warnings.push(
        `Removed <${el.name}> content that looks like a section: "${text.slice(0, 80)}"`,
      );
  }
  for (const el of removable) $(el).remove();
  $(NOISE_SELECTOR).remove();
  return warnings;
}

/**
 * `detectSections` derives `heading`/`num` from the raw line, struck text included. Recompute
 * them from the non-deleted text so deleted words never reach breadcrumbs or embeddings.
 */
function refineHeading(section: Section): boolean {
  const line: { char: string; deleted: boolean }[] = [];
  collect: for (const span of section.spans) {
    for (const char of span.text) {
      if (char === '\n') break collect;
      line.push({ char, deleted: span.status === 'deleted' });
    }
  }
  while (/\s/.test(line.at(-1)?.char ?? 'x')) line.pop();
  const before = section.num;
  const heading = section.heading ?? '';
  const raw = line.map((c) => c.char).join('');
  if (!raw.endsWith(heading)) return false;
  const split = line.length - heading.length;
  const visible = (part: typeof line) =>
    part
      .filter((c) => !c.deleted)
      .map((c) => c.char)
      .join('');

  if (line.slice(split).some((c) => c.deleted)) {
    const cleaned = visible(line.slice(split))
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.:]\s*/, '');
    if (cleaned) section.heading = cleaned;
    else delete section.heading;
  }
  const prefix = line.slice(0, split);
  if (prefix.some((c) => c.deleted)) {
    const text = visible(prefix);
    const found = section.num?.startsWith('(')
      ? /\(([^)\s]+)\)/.exec(text)?.[1]
      : /^\s*(?:(?:section|sec|article|art|chapter|ch)\b\.?|§)?\s*([a-z0-9]+(?:[.-][a-z0-9]+)*)[.:\s]*$/i.exec(
          text,
        )?.[1];
    if (found)
      section.num = section.num?.startsWith('(') ? `(${found})` : found;
    else delete section.num;
  }
  return section.num !== before && section.num !== undefined;
}

/** Rewrite `from/` to `to/` at the start of every descendant id. */
function reprefix(section: Section, from: string, to: string): void {
  for (const child of section.children) {
    child.id = to + child.id.slice(from.length);
    reprefix(child, from, to);
  }
}

/**
 * Refine headings, then keep ids consistent with the refined `num`: an id is
 * `<parent id>/<sec|chapter|article>-<marker>` (or `<parent id>/<marker>` for an
 * enumeration), the same shape `sections.ts` builds, with the same `~n` suffix on collision.
 * A section whose number is entirely struck keeps its original id: that id is the stable
 * position-derived name (nothing visible is left to derive one from).
 */
function refineIds(roots: Section[]): void {
  const used = new Set<string>();
  for (const section of walkSections(roots)) used.add(section.id);
  const visit = (section: Section, parentId: string | undefined): void => {
    if (refineHeading(section) && section.num) {
      const old = section.id;
      const segment = old.slice(old.lastIndexOf('/') + 1).replace(/~\d+$/, '');
      const kind = /^(sec|chapter|article)-/.exec(segment)?.[1];
      const marker = section.num.replace(/^\((.*)\)$/, '$1').toLowerCase();
      const base = `${parentId ? `${parentId}/` : ''}${kind ? `${kind}-` : ''}${marker}`;
      used.delete(old);
      let id = base;
      for (let count = 2; used.has(id); count++)
        id = `${base}~${String(count)}`;
      used.add(id);
      if (id !== old) {
        for (const child of walkSections(section.children))
          used.delete(child.id);
        section.id = id;
        reprefix(section, old, id);
        // Descendant ids moved with the parent.
        for (const child of walkSections(section.children)) {
          used.add(child.id);
        }
      }
    }
    for (const child of section.children) visit(child, section.id);
  };
  for (const root of roots) visit(root, undefined);
}

/** Dropping a deleted span can leave "a  b": collapse the gap it leaves in the kept text. */
function collapseGaps(section: Section): void {
  const spans: Span[] = [];
  let previous = '\n';
  let afterDeleted = false;
  for (const span of section.spans) {
    if (span.status === 'deleted') {
      spans.push(span);
      afterDeleted = true;
      continue;
    }
    let text = span.text;
    if (afterDeleted && /[ \t\n]$/.test(previous)) {
      const gap = /^[ \t]+/.exec(text)?.[0] ?? '';
      if (gap) {
        text = text.slice(gap.length);
        // The whitespace moves into the struck text, so the full (deleted-included) text is intact.
        const struck = spans.findLast((s) => s.status === 'deleted');
        if (struck) struck.text += gap;
      }
    }
    if (text === '') continue;
    spans.push(text === span.text ? span : { ...span, text });
    previous = text;
    afterDeleted = false;
  }
  // Kept text must not end a line with spaces ("and \n."): hand them to the struck text
  // that follows, so the full text with deleted spans is unchanged.
  for (const [index, span] of spans.entries()) {
    if (span.status === 'deleted') continue;
    const trailing = /[ \t]+$/.exec(span.text)?.[0];
    if (!trailing || trailing === span.text) continue;
    let next = index + 1;
    while (spans[next]?.status === 'deleted') next++;
    const struck = spans[index + 1];
    if (next > index + 1 && struck && spans[next]?.text.startsWith('\n')) {
      span.text = span.text.slice(0, -trailing.length);
      struck.text = trailing + struck.text;
    }
  }
  section.spans = spans;
}

/**
 * HTML bill pages: strip page chrome, flow the body into lines (keeping `<pre>` layout),
 * let `detectSections` find the structure, then map strike/underline markup (tags, inline
 * styles and `<style>` class rules) onto `Span.status`.
 */
export function parseHtml(
  input: string | Uint8Array,
  options: HtmlParseOptions,
): NormalizedDoc {
  if (!context.safeParse(options).success) {
    throw new AppError(
      'INVALID_INPUT',
      'Invalid HTML document source or fetch timestamp.',
    );
  }
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const decoded =
    typeof input === 'string'
      ? { html: input, warnings: [] }
      : decodeHtml(input, options);
  const html = decoded.html;
  const $: CheerioAPI = load(html);
  const rules = $('style')
    .toArray()
    .flatMap((style) => readClassRules($(style).text()));
  const warnings = [...decoded.warnings, ...removeNoise($)];
  $('style').remove();

  const builder = new LineBuilder();
  for (const root of $.root().toArray()) {
    for (const child of root.children)
      walk(child, builder, rules, 'unchanged', false);
  }
  builder.endLine();
  // Leading/trailing blank lines (common around <pre>) carry nothing.
  const lines = builder.lines;
  while (lines.length > 0 && lines[0]?.length === 0) lines.shift();
  while (lines.length > 0 && lines.at(-1)?.length === 0) lines.pop();
  if (lines.length === 0)
    throw new AppError('PARSE_FAILED', 'The HTML document has no text.');

  const lineTexts = lines.map((line) => line.map((c) => c.text).join(''));
  const fullText = lineTexts.join('\n');
  const statuses: SpanStatus[] = [];
  for (const [index, line] of lines.entries()) {
    // A loop, not push(...array): spreading a long block overflows the call stack.
    for (const chunk of line)
      for (const _unit of chunk.text.split('')) statuses.push(chunk.status);
    // The joining newline is structure, not amendment text.
    if (index < lines.length - 1) statuses.push('unchanged');
  }
  // Chunk text is built from UTF-16 code units, matching String.length used above.
  const sections = detectSections(lineTexts.map((text) => ({ text })));
  // detectSections never alters source text, so this only fails if that invariant breaks.
  if (!applyStatuses(sections, statuses, fullText)) {
    throw new AppError(
      'PARSE_FAILED',
      'Could not align amendment markup with the detected sections.',
    );
  }
  refineIds(sections);
  for (const section of walkSections(sections)) collapseGaps(section);
  return NormalizedDoc.parse({
    docId: createHash('sha256').update(bytes).digest('hex'),
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt,
    format: 'html',
    metadata: { ...EMPTY_METADATA },
    sections,
    definitions: [],
    externalRefs: [],
    warnings,
  });
}
