import { AppError } from '../model/index.js';
import { ParseBudget, readParseLimits } from './limits.js';

const VOID = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(
    ' ',
  ),
);
const RAW = new Set(
  'script style textarea title xmp iframe noembed noframes'.split(' '),
);
// HTML start tags that end foreign-content parsing (font is treated conservatively).
const FOREIGN_BREAKOUT = new Set(
  'b big blockquote body br center code dd div dl dt em embed font h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var'.split(
    ' ',
  ),
);
export const MAX_HTML_DEPTH = 512;
const SPACE = /[\t\n\f\r ]/;

function depthError(cause?: RangeError): AppError {
  return new AppError('TOO_LARGE', 'HTML nesting depth limit exceeded.', {
    userMessage: `HTML nested deeper than ${String(MAX_HTML_DEPTH)} levels cannot be processed.`,
    ...(cause ? { cause } : {}),
  });
}

/** Also contain stack exhaustion in parse5, Cheerio and recursive HTML/CSS walks. */
export function withHtmlDepthLimit<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof RangeError) throw depthError(error);
    throw error;
  }
}

export function assertHtmlBytes(
  bytes: number,
  maxBytes = readParseLimits().maxHtmlBytes,
): void {
  if (bytes > maxBytes)
    throw new AppError('TOO_LARGE', 'HTML byte limit exceeded.', {
      userMessage: `HTML documents must be at most ${String(maxBytes)} bytes.`,
    });
}

/**
 * A bounded-stack linear scan before parse5. Overestimating malformed/implicitly closed HTML
 * is deliberate: a false refusal is preferable to unbounded synchronous DOM construction.
 * In HTML, a slash on a non-void tag is ignored by parse5; only foreign tags really self-close.
 */
export function assertHtmlDepth(
  html: string,
  budget = new ParseBudget(),
): number {
  const stack: string[] = [];
  const namespaces: ('html' | 'svg' | 'math')[] = [];
  const depths: number[] = [];
  // Reserve implicit html and head/body elements, plus a possible text/comment leaf.
  const implicitDepth = 3;
  let maximum = implicitDepth;
  let retainedLevels = 0;
  let at = 0;
  while (at < html.length) {
    budget.check();
    const start = html.indexOf('<', at);
    if (start < 0) break;
    at = start + 1;
    if (html.startsWith('!--', at)) {
      at += 3;
      if (html[at] === '>') {
        at++;
        continue;
      }
      if (html.startsWith('->', at)) {
        at += 2;
        continue;
      }
      const end = /--!?>/g;
      end.lastIndex = at;
      const match = end.exec(html);
      at = match ? end.lastIndex : html.length;
      continue;
    }
    const closing = html[at] === '/';
    if (closing) at++;
    if (!/[a-zA-Z]/.test(html.charAt(at))) {
      // Declarations, processing instructions and invalid end tags are bogus comments.
      // Their contents cannot open or close elements.
      if (closing || html[at] === '!' || html[at] === '?') {
        const end = html.indexOf('>', at);
        at = end < 0 ? html.length : end + 1;
      }
      continue;
    }
    const nameStart = at;
    while (
      at < html.length &&
      !SPACE.test(html.charAt(at)) &&
      !'/>'.includes(html.charAt(at))
    )
      at++;
    const name = html.slice(nameStart, at).toLowerCase();
    type AttributeState =
      | 'before-name'
      | 'name'
      | 'after-name'
      | 'before-value'
      | 'unquoted'
      | 'quoted'
      | 'after-quoted'
      | 'self-closing';
    let state: AttributeState = 'before-name';
    let quote = '';
    let selfClosing = false;
    while (at < html.length) {
      if (at % 4096 === 0) budget.check();
      const char = html.charAt(at++);
      if (state === 'quoted') {
        if (char === quote) state = 'after-quoted';
        continue;
      }
      if (char === '>') {
        selfClosing = state === 'self-closing';
        break;
      }
      if (state === 'before-value') {
        if (SPACE.test(char)) continue;
        if (char === '"' || char === "'") {
          quote = char;
          state = 'quoted';
        } else state = 'unquoted';
      } else if (state === 'unquoted') {
        // Quotes, equals signs and slashes inside unquoted values are literals.
        if (SPACE.test(char)) state = 'before-name';
      } else if (state === 'name' && char === '=') {
        state = 'before-value';
      } else if (SPACE.test(char)) {
        state =
          state === 'before-name' ||
          state === 'after-quoted' ||
          state === 'self-closing'
            ? 'before-name'
            : 'after-name';
      } else if (char === '/') {
        state = 'self-closing';
      } else if (state === 'after-name' && char === '=') {
        state = 'before-value';
      } else {
        // In before-name, '=' starts an attribute name rather than a value.
        state = 'name';
      }
    }
    if (closing) {
      // Stray </p> and </br> tokens can create an element in HTML tree construction.
      if (name === 'p' || name === 'br') {
        maximum = Math.max(maximum, (depths.at(-1) ?? implicitDepth) + 1);
        if (maximum > MAX_HTML_DEPTH) throw depthError();
      }
      // Mismatched end tags may be ignored by HTML tree construction. Never let one
      // reduce our estimate; only a matching top-of-stack end tag closes a level.
      if (stack.at(-1) === name && stack.length > retainedLevels) {
        stack.pop();
        namespaces.pop();
        depths.pop();
      }
      continue;
    }
    const parentNamespace = namespaces.at(-1) ?? 'html';
    const parentName = stack.at(-1) ?? '';
    const integration =
      parentNamespace === 'svg'
        ? ['foreignobject', 'desc', 'title'].includes(parentName)
        : parentNamespace === 'math' &&
          ['annotation-xml', 'mi', 'mo', 'mn', 'ms', 'mtext'].includes(
            parentName,
          );
    if (parentNamespace !== 'html' && FOREIGN_BREAKOUT.has(name)) {
      // Even a void breakout such as <br> switches later tags back to HTML, where
      // self-closing slashes are ignored. Keep the stack as a conservative estimate.
      namespaces.fill('html');
    }
    const namespace =
      name === 'svg'
        ? 'svg'
        : name === 'math'
          ? 'math'
          : integration
            ? 'html'
            : (namespaces.at(-1) ?? 'html');
    const foreign = namespace !== 'html';
    const parentDepth = depths.at(-1) ?? implicitDepth;
    // Tables may insert tbody/tr; template contents add a fragment and may insert
    // table containers even without a table start tag. Reserve those levels up front.
    const depth =
      parentDepth + (name === 'table' ? 3 : name === 'template' ? 4 : 1);
    maximum = Math.max(maximum, depth);
    if (maximum > MAX_HTML_DEPTH) throw depthError();
    if ((!foreign && VOID.has(name)) || (selfClosing && foreign)) continue;
    stack.push(name);
    namespaces.push(namespace);
    depths.push(depth);
    // These insertion modes can ignore raw-text tags. Annotation integration also
    // depends on attributes. When uncertain, scan the contents but retain ancestors:
    // apparent end tags may actually be raw text and must not lower the estimate.
    const uncertainMode = stack.some((tag) =>
      [
        'select',
        'frameset',
        'table',
        'template',
        'colgroup',
        'annotation-xml',
      ].includes(tag),
    );
    const rawText = !foreign && !uncertainMode;
    if (!foreign && uncertainMode && (RAW.has(name) || name === 'plaintext'))
      retainedLevels = stack.length;
    if (name === 'plaintext' && rawText) break;
    if (RAW.has(name) && rawText) {
      const end = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'ig');
      end.lastIndex = at;
      const match = end.exec(html);
      at = match?.index ?? html.length;
    }
  }
  budget.check();
  return maximum;
}
