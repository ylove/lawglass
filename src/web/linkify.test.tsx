import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { govHref, linkifyGov } from './linkify.js';

function links(text: string) {
  const { container } = render(<p>{linkifyGov(text, 'k')}</p>);
  return {
    container,
    anchors: Array.from(container.querySelectorAll('a')),
  };
}

describe('govHref', () => {
  test.each([
    'https://congress.gov',
    'https://www.congress.gov/bill/119th-congress/house-bill/1',
    'https://codes.ohio.gov/ohio-revised-code/section-6111.03?x=1#top',
    'https://GOV',
    'https://gov/path',
    'https://a-b.example.gov/p',
    'https://www.GovInfo.GOV/content/pkg',
  ])('accepts %s', (url) => {
    expect(govHref(url)).toBeTruthy();
  });

  test.each([
    ['gov.evil.com', 'https://gov.evil.com'],
    ['evilgov', 'https://evilgov'],
    ['evilgov dotted', 'https://evilgov.com'],
    ['not .gov at all', 'https://example.com/a.gov'],
    ['a .gov path on another host', 'https://evil.com/x.gov'],
    ['lookalike suffix', 'https://notgov.org'],
    ['trailing dot', 'https://congress.gov./x'],
    ['userinfo', 'https://x@evil.com'],
    ['userinfo hiding a gov host', 'https://congress.gov@evil.com/'],
    ['userinfo before a gov host', 'https://evil.com@congress.gov/'],
    ['port', 'https://congress.gov:8443/x'],
    ['punycode label', 'https://xn--ongress-gov-x2b.gov'],
    ['punycode tld-ish', 'https://www.xn--abc.gov'],
    ['unicode lookalike', 'https://cоngress.gov'],
    ['backslash trick', 'https://evil.com\\@congress.gov'],
    ['percent in host', 'https://congress%2egov.evil.com'],
    ['empty host', 'https://.gov'],
    ['hyphen edge label', 'https://-a.gov'],
    ['double dot', 'https://a..gov'],
    ['http scheme', 'http://congress.gov'],
    ['javascript', 'javascript:alert(1)//.gov'],
    ['data', 'data:text/html,<a>.gov</a>'],
    ['ftp', 'ftp://congress.gov'],
    ['no host', 'https://'],
  ])('rejects %s', (_name, url) => {
    expect(govHref(url)).toBeUndefined();
  });
});

describe('linkifyGov', () => {
  test('returns plain text unchanged when there is nothing to link', () => {
    expect(linkifyGov('No links here.', 'k')).toEqual(['No links here.']);
    expect(linkifyGov('See https://example.com/page.', 'k')).toEqual([
      'See https://example.com/page.',
    ]);
  });

  test('links a .gov URL safely and keeps the surrounding text', () => {
    const { container, anchors } = links(
      'Read https://www.congress.gov/bill/1 today',
    );
    expect(anchors).toHaveLength(1);
    const a = anchors[0]!;
    expect(a.getAttribute('href')).toBe('https://www.congress.gov/bill/1');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('https://www.congress.gov/bill/1');
    expect(container.textContent).toBe(
      'Read https://www.congress.gov/bill/1 today',
    );
  });

  test.each([
    ['.', 'See https://congress.gov/x.'],
    [',', 'See https://congress.gov/x, then'],
    [';', 'See https://congress.gov/x; then'],
    [')', '(see https://congress.gov/x)'],
    ['.)', '(see https://congress.gov/x.)'],
    ['?', 'Is it https://congress.gov/x?'],
  ])('leaves trailing %s out of the link', (_p, text) => {
    const { container, anchors } = links(text);
    expect(anchors[0]?.getAttribute('href')).toBe('https://congress.gov/x');
    expect(anchors[0]?.textContent).toBe('https://congress.gov/x');
    expect(container.textContent).toBe(text);
  });

  test('a bare host followed by a period links the host only', () => {
    const { anchors } = links('Go to https://congress.gov.');
    expect(anchors[0]?.getAttribute('href')).toBe('https://congress.gov/');
  });

  test('links several URLs and skips the ones that are not .gov', () => {
    const { container, anchors } = links(
      'A https://a.gov/x and https://evil.com/y and https://b.gov/z.',
    );
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      'https://a.gov/x',
      'https://b.gov/z',
    ]);
    expect(container.textContent).toBe(
      'A https://a.gov/x and https://evil.com/y and https://b.gov/z.',
    );
  });

  test('does not link lookalikes, userinfo, ports or other schemes', () => {
    for (const text of [
      'https://gov.evil.com/x',
      'https://evilgov/x',
      'https://xn--e1afmkfd.gov/x',
      'https://x@evil.com',
      'https://congress.gov@evil.com',
      'https://congress.gov:444/x',
      'http://congress.gov',
      'javascript:alert(1)',
      'data:text/html;base64,AAAA',
    ]) {
      const { container, anchors } = links(`See ${text} now`);
      expect(anchors, text).toHaveLength(0);
      expect(container.textContent).toBe(`See ${text} now`);
    }
  });

  test('stops a URL at a citation marker bracket', () => {
    const { container, anchors } = links(
      'Filed at https://congress.gov/x [S:sec-1] and https://a.gov/y[S:sec-2].',
    );
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      'https://congress.gov/x',
      'https://a.gov/y',
    ]);
    expect(container.textContent).toContain('[S:sec-1]');
  });

  test('never emits markup from the text', () => {
    const { container, anchors } = links(
      'https://a.gov/"><img src=x onerror=alert(1)>',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(anchors[0]?.getAttribute('href')).toBe('https://a.gov/');
  });
});
