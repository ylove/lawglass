import type { DocFormat } from '../model/index.js';

export type SniffedFormat = DocFormat | 'unknown';

const XML_ROOTS = new Set([
  'bill',
  'resolution',
  'amendment-doc',
  'uslm',
  'lawdoc',
  'akomantoso',
  'tei',
]);
const HTML_ELEMENTS = new Set(
  (
    'a abbr address area article aside audio b base bdi bdo blockquote body br button ' +
    'canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt ' +
    'em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr ' +
    'i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript ' +
    'object ol optgroup option output p picture pre progress q rp rt ruby s samp script search ' +
    'section select slot small source span strong style sub summary sup table tbody td template ' +
    'textarea tfoot th thead time title tr track u ul var video wbr'
  ).split(' '),
);

export function formatFromExtension(url: string): SniffedFormat {
  const extension = /\.(pdf|xml|html?|txt)$/.exec(
    new URL(url).pathname.toLowerCase(),
  )?.[1];
  if (extension === 'htm' || extension === 'html') return 'html';
  if (extension === 'txt') return 'text';
  if (extension === 'pdf' || extension === 'xml') return extension;
  return 'unknown';
}

export function sniffFormat(
  bytes: Uint8Array,
  contentType: string,
  url: string,
): SniffedFormat {
  const prefix = new TextDecoder()
    .decode(bytes.subarray(0, 8192))
    .trimStart()
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (prefix.startsWith('%PDF-')) return 'pdf';
  if (/^<\?xml\b/i.test(prefix)) return 'xml';
  const root = /^<([a-z][\w:.-]*)\b/i.exec(prefix)?.[1]?.toLowerCase();
  if (root && XML_ROOTS.has(root.split(':').at(-1) ?? root)) return 'xml';
  if (/^<!doctype\s+html\b|^<html\b/i.test(prefix)) return 'html';

  const mime = contentType.split(';')[0]?.trim().toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (
    mime === 'application/xml' ||
    mime === 'text/xml' ||
    mime?.endsWith('+xml')
  )
    return 'xml';
  if (mime === 'text/plain') return 'text';
  const extension = formatFromExtension(url);
  if (extension !== 'unknown') return extension;
  if (root) return HTML_ELEMENTS.has(root) ? 'html' : 'xml';
  try {
    // Streaming decode ignores a partial UTF-8 codepoint at the sample boundary.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, 8192),
      { stream: bytes.length > 8192 },
    );
    if (
      text.length &&
      (text.match(/[^\p{C}]|[\t\r\n]/gu) ?? []).join('').length / text.length >=
        0.9
    )
      return 'text';
  } catch {
    /* Binary data is not a text fallback. */
  }
  return 'unknown';
}
