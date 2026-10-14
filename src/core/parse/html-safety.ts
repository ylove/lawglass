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
): void {
  const stack: string[] = [];
  const foreignStack: boolean[] = [];
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
    const nameStart = at;
    while (at < html.length && /[a-zA-Z0-9:-]/.test(html.charAt(at))) at++;
    const name = html.slice(nameStart, at).toLowerCase();
    if (!/^[a-z]/.test(name)) continue;
    let quote = '';
    let previous = '';
    while (at < html.length) {
      const char = html.charAt(at++);
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      if (!/\s/.test(char)) previous = char;
    }
    if (closing) {
      // Mismatched end tags may be ignored by HTML tree construction. Never let one
      // reduce our estimate; only a matching top-of-stack end tag closes a level.
      if (stack.at(-1) === name) {
        stack.pop();
        foreignStack.pop();
      }
      continue;
    }
    const integration = [
      'foreignobject',
      'desc',
      'title',
      'annotation-xml',
      'mi',
      'mo',
      'mn',
      'ms',
      'mtext',
    ].includes(stack.at(-1) ?? '');
    if (foreignStack.at(-1) && FOREIGN_BREAKOUT.has(name)) {
      // Even a void breakout such as <br> switches later tags back to HTML, where
      // self-closing slashes are ignored. Keep the stack as a conservative estimate.
      foreignStack.fill(false);
    }
    const foreign =
      name === 'svg' ||
      name === 'math' ||
      (foreignStack.at(-1) === true && !integration);
    if (VOID.has(name) || (previous === '/' && foreign)) continue;
    stack.push(name);
    foreignStack.push(foreign);
    if (stack.length > MAX_HTML_DEPTH)
      throw new AppError('TOO_LARGE', 'HTML nesting depth limit exceeded.', {
        userMessage: `HTML nested deeper than ${String(MAX_HTML_DEPTH)} levels cannot be processed.`,
      });
    if (name === 'plaintext') break;
    if (RAW.has(name) && !foreign) {
      const end = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      end.lastIndex = at;
      const match = end.exec(html);
      at = match?.index ?? html.length;
    }
  }
  budget.check();
}
