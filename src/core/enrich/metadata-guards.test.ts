import { describe, expect, it } from 'vitest';
import {
  parseSponsor,
  sponsorRegion,
  verifyBillNumber,
  verifyJurisdiction,
  verifySession,
  verifySponsor,
  verifyTitle,
  verifyVersion,
} from './metadata-guards.js';
import { EMPTY_METADATA, type BillMetadata } from '../model/index.js';
import { sourceFor } from './metadata.js';

// Synthetic text laid out like the real federal XML and Ohio PDF headers.
const FED = `119 S202 IS: Helping Small Businesses To Hedge Risk Act
119th CONGRESS 1st Session S. 202 IN THE SENATE OF THE UNITED STATES
January 23, 2025 Mrs. Shaheen (for herself and Mr. Cassidy ) introduced the following bill
A BILL To require the Administrator to establish a program for small business concerns.
1. Short title This Act may be cited as the Helping Small Businesses THRIVE Act.
In this Act we do each task. The Revised Code of California is not amended. Lee Day Doe.`;

const OHIO = `As Introduced
136th General Assembly
Regular Session   S. B. No. 113
2025-2026
Senator Brenner
Cosponsors: Senators Cirino, Schaffer, O'Brien
A B I L L
To   amend   sections   3314.03   and   to   enact   section   3313.475   of   the   Revised   Code.
BE IT ENACTED BY THE GENERAL ASSEMBLY OF THE STATE OF OHIO:
Day Lee Doe`;

describe('verifyBillNumber', () => {
  it.each(['S. B. No. 113', 'S.B. 113', 'SB 113', 'Senate Bill 113', 'SB113'])(
    'accepts %s for "S. B. No. 113"',
    (v) => {
      expect(verifyBillNumber(v, OHIO)).toBe(true);
    },
  );
  it.each(['S. 20', 'S. 2', 'S. 2020', '202', 'H.R. 202', 'HB 202'])(
    'rejects %s against "S. 202" (prefix, bare number, wrong chamber)',
    (v) => {
      expect(verifyBillNumber(v, FED)).toBe(false);
    },
  );
  it('accepts S. 202 and rejects a number without a chamber', () => {
    expect(verifyBillNumber('S.202', FED)).toBe(true);
    expect(verifyBillNumber('S202', FED)).toBe(true);
    expect(verifyBillNumber('113', OHIO)).toBe(false);
  });
  it('normalises House forms and joint resolutions', () => {
    const t = 'H. R. 1234 and H.B. 55 and H.J. Res. 7';
    expect(verifyBillNumber('HR 1234', t)).toBe(true);
    expect(verifyBillNumber('House Bill No. 55', t)).toBe(true);
    expect(verifyBillNumber('HJRES 7', t)).toBe(true);
    expect(verifyBillNumber('HR 123', t)).toBe(false);
  });
});

describe('verifySession', () => {
  it.each([
    '136th General Assembly',
    '136th General Assembly (2025-2026)',
    '136th General Assembly, Regular Session 2025-2026',
  ])('accepts %s for the Ohio header', (v) => {
    expect(verifySession(v, OHIO)).toBe(true);
  });
  it('accepts the federal form and rejects richer claims whose parts are absent', () => {
    expect(verifySession('119th Congress, 1st Session', FED)).toBe(true);
    expect(verifySession('119th Congress (2025-2026)', FED)).toBe(false); // 2026 not printed
    expect(verifySession('120th Congress', FED)).toBe(false);
  });
  it.each(['1st', '119', '1st Session', '2025'])(
    'rejects the bare fragment %s',
    (v) => {
      expect(verifySession(v, FED)).toBe(false);
    },
  );
  it('rejects a body or session kind the text does not use', () => {
    expect(verifySession('136th Congress', OHIO)).toBe(false);
    expect(verifySession('136th General Assembly, Special Session', OHIO)).toBe(
      false,
    );
  });
});

describe('verifySponsor', () => {
  it('accepts printed names, with or without printed titles', () => {
    expect(verifySponsor('Mrs. Shaheen', FED)).toBe(true);
    expect(verifySponsor('Sen. Shaheen', FED)).toBe(true);
    expect(verifySponsor('Senator Brenner', OHIO)).toBe(true);
    expect(verifySponsor("Sen. O'Brien (R-OH)", OHIO)).toBe(true);
  });
  it('requires the first name when given, and a matching chamber', () => {
    expect(verifySponsor('Rep. Jane Shaheen', FED)).toBe(false);
    expect(verifySponsor('Sen. Jeanne Shaheen', FED)).toBe(false);
    expect(verifySponsor('Rep. Shaheen', FED)).toBe(false); // text is the Senate
    expect(verifySponsor('Rep. Brenner', OHIO)).toBe(false);
  });
  it('does not let ordinary words or later sections vouch for invented names', () => {
    for (const n of ['Rep. Jane Doe', 'Lee', 'Jane Day', 'Doe'])
      expect(verifySponsor(n, FED)).toBe(false);
    expect(verifySponsor('Jane Day', OHIO)).toBe(false);
    expect(verifySponsor('Lee', OHIO)).toBe(false);
  });
  it('matches whole words, not substrings of longer names', () => {
    expect(verifySponsor('Shaheens', FED)).toBe(false);
    expect(verifySponsor('Shahee', FED)).toBe(false);
  });
  it('handles "Surname, First" order and initials', () => {
    const t = 'Smith, John introduced the following bill\nA BILL To x.';
    expect(verifySponsor('Smith, John', t)).toBe(true);
    expect(verifySponsor('John Smith', t)).toBe(true);
    expect(verifySponsor('Smith, Jane', t)).toBe(false);
    expect(verifySponsor('J. Smith', t)).toBe(true);
    expect(verifySponsor('K. Smith', t)).toBe(false);
    const t2 = 'Mr. John Q. Smith introduced\nA BILL';
    expect(verifySponsor('John Smith', t2)).toBe(true);
  });
  it('rejects short surnames unless the full name appears', () => {
    const t = 'Mr. Wu introduced; Ho Chi Wu also\nA BILL To x.';
    expect(verifySponsor('Wu', t)).toBe(false);
    expect(verifySponsor('Chi Wu', t)).toBe(true);
  });
  it('rejects unparseable names', () => {
    expect(parseSponsor('Sen.')).toBeNull();
    expect(verifySponsor('(D)', FED)).toBe(false);
  });
  it('limits the search to the text before the bill body', () => {
    expect(sponsorRegion(FED)).not.toMatch(/Revised Code/);
    expect(sponsorRegion('x'.repeat(3000))).toHaveLength(1500);
    expect(parseSponsor('Rep. Smith, John Jr.')).toEqual({
      surname: 'Smith',
      first: 'John',
      chamber: 'house',
    });
  });
});

describe('verifyTitle', () => {
  it('accepts the short title and the official title, including slight variations', () => {
    expect(verifyTitle('Helping Small Businesses THRIVE Act', FED)).toBe(true);
    expect(
      verifyTitle(
        'To require the Administrator to establish a program for small business concerns',
        FED,
      ),
    ).toBe(true);
    expect(verifyTitle('Helping Small Businesses Thrive Program', FED)).toBe(
      true,
    ); // 4 of 5 tokens in one span
  });
  it('rejects invented or scattered titles', () => {
    expect(verifyTitle('Totally Invented Act', FED)).toBe(false);
    expect(verifyTitle('Act', FED)).toBe(false);
    expect(verifyTitle('Small Revised Introduced Code Doe', FED)).toBe(false);
  });
});

describe('verifyJurisdiction', () => {
  it('derives jurisdiction from explicit markers only', () => {
    expect(verifyJurisdiction('Ohio', OHIO)).toBe('Ohio');
    expect(verifyJurisdiction('State of Ohio', OHIO)).toBe('Ohio');
    expect(verifyJurisdiction('United States', FED)).toBe('United States');
    expect(verifyJurisdiction('Federal', FED)).toBe('United States');
  });
  it('rejects values inferred from passing mentions or the wrong body', () => {
    expect(verifyJurisdiction('California', FED)).toBeNull(); // mentioned, not enacting
    expect(verifyJurisdiction('Ohio', FED)).toBeNull();
    expect(verifyJurisdiction('United States', OHIO)).toBeNull();
    expect(verifyJurisdiction('Narnia', OHIO)).toBeNull();
    expect(
      verifyJurisdiction('United States', 'under the United States Code'),
    ).toBeNull();
  });
});

describe('verifyVersion', () => {
  it('requires the version to appear', () => {
    expect(verifyVersion('As Introduced', OHIO)).toBe(true);
    expect(verifyVersion('as   introduced', OHIO)).toBe(true);
    expect(verifyVersion('Enrolled', OHIO)).toBe(false);
    expect(verifyVersion('Introduced in Senate', FED)).toBe(false);
    expect(verifyVersion('', FED)).toBe(false);
  });
});

describe('sourceFor', () => {
  const structured = (n: number): BillMetadata => ({
    ...EMPTY_METADATA,
    title: n > 0 ? 't' : null,
    billNumber: n > 1 ? 'b' : null,
    session: n > 2 ? 's' : null,
    source: 'structured',
  });
  it('keeps the existing source when nothing was added', () => {
    expect(sourceFor(structured(2), 0)).toBe('structured');
    expect(sourceFor(EMPTY_METADATA, 0)).toBe('none');
  });
  it('is structured only while structured fields outnumber extracted ones', () => {
    expect(sourceFor(structured(3), 2)).toBe('structured');
    expect(sourceFor(structured(2), 2)).toBe('extracted');
    expect(sourceFor(structured(1), 2)).toBe('extracted');
    expect(sourceFor(EMPTY_METADATA, 1)).toBe('extracted');
  });
});
