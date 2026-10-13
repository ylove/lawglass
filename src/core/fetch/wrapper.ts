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
  // Cheerio's text() concatenates siblings; preserve boundaries for headings and body words.
  $(
    'address, article, aside, blockquote, br, dd, div, dl, dt, fieldset, figcaption, figure, ' +
      'h1, h2, h3, h4, h5, h6, hr, li, main, ol, p, pre, section, table, td, th, tr, ul',
  ).each((_index, element) => {
    $(element).prepend('\n').append('\n');
  });
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const hasSection = /\b(?:section|sec\.)\s+\d+[a-z]?\s*\./i.test(text);
  const subsections = text.match(/\((?:[a-z]|\d+)\)/gi) ?? [];
  const billLike =
    hasSection && (text.length >= 400 || subsections.length >= 2);
  return (
    !billLike && findCandidateLinks(html, 'https://wrapper.invalid/').length > 0
  );
}
