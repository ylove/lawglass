// Turns plain `https://...gov` URLs in untrusted text (bills, model output, official summaries)
// into links. Deliberately narrow: only the `.gov` top-level domain, only https, only a bare
// hostname. The allow-list is checked on the raw text, not on a parsed URL, because parsers
// are forgiving (they strip userinfo, fold unicode, drop trailing dots) and a forgiving
// parser is exactly what a lookalike link relies on. Output is React elements only.
import type { ReactNode } from 'react';

/** A candidate runs from `https://` to whitespace or a character that cannot be in a link here. */
const CANDIDATE = /https:\/\/[^\s<>"'`[\]\\*{}|^]+/gi;
/** Sentence punctuation that follows a URL in prose but is not part of it. */
const TRAILING = '.,;:!?)';
/** `gov` itself, or any dotted ASCII hostname ending in `.gov`. No ports, userinfo or dots at the end. */
const GOV_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*gov$/i;

/** Linear scan from the end; a regex for this would be quadratic on a long run of punctuation. */
function trimTrailing(candidate: string): string {
  let end = candidate.length;
  while (end > 0 && TRAILING.includes(candidate[end - 1] ?? '')) end--;
  return candidate.slice(0, end);
}

/** Returns the safe href for a `.gov` https URL, or undefined for anything else. */
export function govHref(candidate: string): string | undefined {
  const rest = candidate.slice('https://'.length);
  // The authority ends at the first path, query or fragment delimiter.
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (!GOV_HOST.test(authority)) return undefined;
  // Punycode labels can render as a lookalike of a trusted name; no real .gov host needs one.
  if (authority.split('.').some((label) => /^xn--/i.test(label)))
    return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return undefined;
    // Belt and braces: the parsed host must be the host we validated.
    if (url.hostname !== authority.toLowerCase()) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Splits text into plain strings and `.gov` links. Everything else is returned unchanged. */
export function linkifyGov(text: string, keyPrefix: string): ReactNode[] {
  if (!text.includes('://')) return [text];
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CANDIDATE)) {
    const trimmed = trimTrailing(m[0]);
    const href = govHref(trimmed);
    if (!href) continue;
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(
      <a
        key={`${keyPrefix}-gov-${String(m.index)}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {trimmed}
      </a>,
    );
    // Trimmed punctuation stays in the text that follows the link.
    last = m.index + trimmed.length;
  }
  if (nodes.length === 0) return [text];
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
