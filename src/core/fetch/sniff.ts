import type { DocFormat } from '../model/index.js';

export type SniffedFormat = DocFormat | 'unknown';

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
  if (/^<!doctype\s+html\b|^<html\b/i.test(prefix)) return 'html';
  if (/^<\?xml\b/i.test(prefix)) return 'xml';
  const root = /^<([a-z][\w:.-]*)\b/i.exec(prefix)?.[1];
  if (root) return 'xml';

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
