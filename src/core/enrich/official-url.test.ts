import { describe, expect, it } from 'vitest';
import { officialUrl, parseUsCodeCitation, usCodeUrl } from './official-url.js';

const GOVINFO = 'https://www.govinfo.gov/link';

describe('officialUrl: U.S. Code', () => {
  it.each([
    ['15 U.S.C. 6809', '15/6809'],
    ['15 U.S.C. 6809(4)', '15/6809'],
    ['12 U.S.C. 1813 et seq.', '12/1813'],
    ['12 U.S.C. 1813 et seq', '12/1813'],
    ['15 U.S.C. 6801 to 6809', '15/6801'],
    ['42 U.S.C. 1395w-4', '42/1395w-4'],
    ['15 U.S.C. 78o-6', '15/78o-6'],
    ['5 U.S.C. 552', '5/552'],
    ['26 U.S.C. 7701(a)(1)', '26/7701'],
  ])('links %s to the govinfo link service', (citation, path) => {
    expect(officialUrl(citation)).toBe(
      `${GOVINFO}/uscode/${path}?link-type=html`,
    );
  });

  it.each([
    '0 U.S.C. 1',
    '55 U.S.C. 1',
    '15 U.S.C. ',
    '15 U.S.C. abc',
    '15 U.S.C. 6809/../x',
    '15 U.S.C. 6809?x=1',
    'See 15 U.S.C. 6809',
    '15 USC 6809',
    'the Gramm-Leach-Bliley Act § 509',
  ])('does not link the near miss %j', (citation) => {
    expect(officialUrl(citation)).toBeUndefined();
  });

  it('parses the title and first section, and builds the same link', () => {
    expect(parseUsCodeCitation('12 U.S.C. 1813(c)')).toEqual({
      title: 12,
      section: '1813',
    });
    expect(usCodeUrl(12, '1813')).toBe(officialUrl('12 U.S.C. 1813'));
  });
});

describe('officialUrl: other federal sources', () => {
  it('links public laws', () => {
    expect(officialUrl('Public Law 116-260')).toBe(
      `${GOVINFO}/plaw/116/public/260?link-type=html`,
    );
    expect(officialUrl('Pub. L. 116–260')).toBe(
      `${GOVINFO}/plaw/116/public/260?link-type=html`,
    );
    expect(officialUrl('Public Law 116')).toBeUndefined();
    expect(officialUrl('Public Law 1160-260')).toBeUndefined();
  });

  it('links Statutes at Large', () => {
    expect(officialUrl('134 Stat. 1182')).toBe(`${GOVINFO}/statute/134/1182`);
    expect(officialUrl('134 Stat.')).toBeUndefined();
  });

  it('links the eCFR by section or by part, never anything else', () => {
    expect(officialUrl('42 CFR 438.3')).toBe(
      'https://www.ecfr.gov/current/title-42/section-438.3',
    );
    expect(officialUrl('12 CFR 1005')).toBe(
      'https://www.ecfr.gov/current/title-12/part-1005',
    );
    expect(officialUrl('12 CFR 1005-2')).toBeUndefined();
    expect(officialUrl('12 CFR')).toBeUndefined();
  });
});

describe('officialUrl: Ohio Revised Code', () => {
  it('keeps the codes.ohio.gov mapping', () => {
    expect(officialUrl('R.C. 3501.01')).toBe(
      'https://codes.ohio.gov/ohio-revised-code/section-3501.01',
    );
    expect(officialUrl('R.C. Chapter 3501')).toBe(
      'https://codes.ohio.gov/ohio-revised-code/chapter-3501',
    );
    expect(officialUrl('Ohio Revised Code, Title 35')).toBe(
      'https://codes.ohio.gov/ohio-revised-code/title-35',
    );
  });

  it('refuses ranges, traversal, charters and unparsed Acts', () => {
    expect(officialUrl('R.C. 5747.01 to 5747.05')).toBeUndefined();
    expect(officialUrl('R.C. 1.1/../x')).toBeUndefined();
    expect(officialUrl('Columbus City Charter')).toBeUndefined();
    expect(officialUrl('Columbus City Code § 1234.56')).toBeUndefined();
    expect(officialUrl('Social Security Act § 1902')).toBeUndefined();
  });
});

describe('officialUrl: guards and New York', () => {
  it('links Public Laws only from the 104th Congress, where GovInfo has them', () => {
    expect(officialUrl('Public Law 103-1')).toBeUndefined();
    expect(officialUrl('Public Law 89-97')).toBeUndefined();
    expect(officialUrl('Public Law 104-1')).toBe(
      `${GOVINFO}/plaw/104/public/1?link-type=html`,
    );
  });

  it('links CFR titles 1 to 50 only', () => {
    for (const t of ['0', '51', '99'])
      expect(officialUrl(`${t} CFR 1`)).toBeUndefined();
    expect(officialUrl('50 CFR 17')).toBe(
      'https://www.ecfr.gov/current/title-50/part-17',
    );
  });

  it('reads an en or em dash inside a U.S. Code section as a hyphen', () => {
    expect(officialUrl('42 U.S.C. 1395w–4')).toBe(
      `${GOVINFO}/uscode/42/1395w-4?link-type=html`,
    );
    expect(officialUrl('42 U.S.C. 1395w—4')).toBe(
      `${GOVINFO}/uscode/42/1395w-4?link-type=html`,
    );
  });

  it('links New York laws whose id is certain, and nothing else', () => {
    expect(officialUrl('New York public health law § 1-a')).toBe(
      'https://www.nysenate.gov/legislation/laws/PBH/1-a',
    );
    expect(officialUrl('New York vehicle and traffic law § 1111')).toBe(
      'https://www.nysenate.gov/legislation/laws/VAT/1111',
    );
    expect(officialUrl('New York town law § 20')).toBeUndefined();
    expect(officialUrl('New York labor law § 1/../2')).toBeUndefined();
    expect(officialUrl('New Jersey labor law § 12')).toBeUndefined();
  });
});

describe('officialUrl: hyphenated ranges', () => {
  it('link the first section of a range, but keep lettered dashed sections whole', () => {
    expect(officialUrl('15 U.S.C. 6801-6809')).toBe(
      `${GOVINFO}/uscode/15/6801?link-type=html`,
    );
    expect(parseUsCodeCitation('15 U.S.C. 6801–6809')?.section).toBe('6801');
    expect(officialUrl('42 U.S.C. 300gg-91')).toBe(
      `${GOVINFO}/uscode/42/300gg-91?link-type=html`,
    );
  });
});
