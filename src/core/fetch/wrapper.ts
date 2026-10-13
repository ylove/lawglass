import { load } from 'cheerio';
import { CandidateLink } from '../model/index.js';
import { formatFromExtension } from './sniff.js';

export function findCandidateLinks(
  html: string,
  baseUrl: string,
): CandidateLink[] {
  const $ = load(html);
  const candidates: CandidateLink[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_index, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    const href = $(element).attr('href');
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      const format = formatFromExtension(url.href);
      if (
        format === 'unknown' &&
        !/\b(?:pdf|xml|bill\s+text|as\s+introduced|enrolled|text)\b/i.test(text)
      )
        return;
      if (!seen.has(url.href)) {
        candidates.push(CandidateLink.parse({ url: url.href, text, format }));
        seen.add(url.href);
      }
    } catch {
      /* Malformed links are not document candidates. */
    }
  });
  return candidates;
}

export function isLikelyWrapper(html: string): boolean {
  const $ = load(html);
  $('script, style, nav, header, footer').remove();
  const text = $('body').text().replace(/\s+/g, ' ');
  const sections = text.match(/\b(?:section|sec\.)\s+\d+[a-z]?\s*\./gi) ?? [];
  // A govinfo <pre> can hold a complete one-section bill alongside navigation links.
  const fullPre = $('pre')
    .toArray()
    .some(
      (element) =>
        $(element).text().length >= 200 &&
        /\b(?:section|sec\.)\s+\d+/i.test($(element).text()),
    );
  return (
    !fullPre &&
    sections.length < 2 &&
    findCandidateLinks(html, 'https://wrapper.invalid/').length > 0
  );
}
