import { expect, it } from 'vitest';
import { CandidateLink } from '../model/index.js';
import { findCandidateLinks, isLikelyWrapper } from './wrapper.js';

it('extracts absolute candidates by extension or label, deduplicating URLs', () => {
  const html = `<a href="bill.PDF?download=1"> Download </a><a href="bill.xml">XML</a>
    <a href="/bill.htm">HTML</a><a href="/bill.html">HTML</a><a href="/bill.txt">Plain</a>
    <a href="/download"> As Introduced </a><a href="/enrolled">Enrolled</a>
    <a href="/text">Text</a><a href="/bill-text">bill text</a>
    <a href="bill.xml">Duplicate</a><a href="/home">Home</a>
    <a href="javascript:alert(1)">PDF</a><a href="file:///bill.xml">XML</a>
    <a href="http://[bad">PDF</a><a href="">PDF</a>`;
  const links = findCandidateLinks(
    html,
    'https://example.gov/bills/index.html',
  );
  expect(links).toHaveLength(9);
  expect(links[0]).toEqual({
    url: 'https://example.gov/bills/bill.PDF?download=1',
    text: 'Download',
    format: 'pdf',
  });
  expect(links.map((c) => c.format)).toEqual([
    'pdf',
    'xml',
    'html',
    'html',
    'text',
    'unknown',
    'unknown',
    'unknown',
    'unknown',
  ]);
  for (const link of links)
    expect(CandidateLink.safeParse(link).success).toBe(true);
});
it('recognizes a wrapper with little bill text and ignores scripted section patterns', () => {
  expect(
    isLikelyWrapper(
      '<html><script>SECTION 1. SECTION 2.</script><a href="bill.pdf">PDF</a></html>',
    ),
  ).toBe(true);
  expect(
    isLikelyWrapper('<a href="bill.xml">XML</a><p>SECTION 1. Title.</p>'),
  ).toBe(true);
  expect(isLikelyWrapper('<p>Home page without any candidate.</p>')).toBe(
    false,
  );
  expect(
    isLikelyWrapper(
      '<p>SECTION 1. Title. Sec. 2. Grants.</p><a href="bill.xml">XML</a>',
    ),
  ).toBe(false);
});
it('preserves a synthetic govinfo full-text preformatted bill with download links', () => {
  const html = `<html><body><nav><a href="bill.pdf">PDF</a></nav><pre>
    [Congressional Bill] A BILL To award grants. Be it enacted by the Senate and House.
    SECTION 1. The department shall award grants to eligible towns for water treatment.
    ${'The department shall report grant awards annually. '.repeat(12)}
    </pre></body></html>`;
  expect(findCandidateLinks(html, 'https://example.gov/bill.htm')).toHaveLength(
    1,
  );
  expect(isLikelyWrapper(html)).toBe(false);
});
