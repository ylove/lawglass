import { createHash } from 'node:crypto';
import { load, type CheerioAPI } from 'cheerio';
import { z } from 'zod';
import {
  AppError,
  EMPTY_METADATA,
  NormalizedDoc,
  type Section,
  type Span,
  type SpanStatus,
} from '../model/index.js';
import { detectSections } from './sections.js';
import type { TextParseOptions } from './text.js';

export type HtmlParseOptions = TextParseOptions;

// domhandler is cheerio's own dependency; derive its node types rather than depend on it.
type AnyNode = ReturnType<CheerioAPI['root']>[number]['children'][number];
type Element = Extract<AnyNode, { attribs: Record<string, string> }>;

const context = z.object({ sourceUrl: z.url(), fetchedAt: z.iso.datetime() });

/** Page chrome, never legislation text. `<style>` is read for class rules, then removed. */
const NOISE_SELECTOR = 'nav, header, footer, script, noscript, template, head';

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
 * Only `.class` and `tag.class` selectors are understood: amendment markup is applied through
 * classes. Tag-only rules (e.g. `a { text-decoration: underline }`) are ignored on purpose, or
 * every link would read as inserted text.
 */
function readClassRules(css: string): ClassRule[] {
  const rules: ClassRule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
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

/** Inline style beats stylesheet classes, which beat the tag's own meaning. */
function ownStatus(element: Element, rules: readonly ClassRule[]): Decoration {
  const inline = decorationFromDeclarations(element.attribs.style ?? '');
  if (inline) return inline;
  const classes = new Set((element.attribs.class ?? '').split(/\s+/));
  let fromClass: Decoration;
  for (const rule of rules) {
    if (
      classes.has(rule.className) &&
      (!rule.tag || rule.tag === element.name.toLowerCase())
    )
      fromClass = rule.status;
  }
  return fromClass ?? TAG_STATUS[element.name.toLowerCase()];
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
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AppError(
      'PARSE_FAILED',
      'The HTML document is not valid UTF-8.',
      {
        cause,
      },
    );
  }
  const $: CheerioAPI = load(html);
  const rules = $('style')
    .toArray()
    .flatMap((style) => readClassRules($(style).text()));
  $(NOISE_SELECTOR).remove();
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
    for (const chunk of line)
      statuses.push(...Array<SpanStatus>(chunk.text.length).fill(chunk.status));
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
  return NormalizedDoc.parse({
    docId: createHash('sha256').update(bytes).digest('hex'),
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt,
    format: 'html',
    metadata: { ...EMPTY_METADATA },
    sections,
    definitions: [],
    externalRefs: [],
    warnings: [],
  });
}
