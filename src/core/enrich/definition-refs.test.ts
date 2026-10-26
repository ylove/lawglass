import { describe, expect, it } from 'vitest';
import { findDefinitionTargets, MAX_TARGETS } from './definition-refs.js';
import { extractDefinitions } from './definitions.js';
import { docOf, sec } from './fixtures.js';
import { buildSectionIndex } from './section-index.js';
import type { Section } from '../model/index.js';

function targetsIn(sections: Section[]) {
  const index = buildSectionIndex(sections);
  return findDefinitionTargets(sections, extractDefinitions(sections, index));
}

describe('findDefinitionTargets: the term is stated', () => {
  it('follows "has the meaning given that term in section N of the Y Act (T U.S.C. S)"', () => {
    const targets = targetsIn([
      sec(
        'sec-2',
        'In this Act:\n(1) Financial institution\nThe term "financial institution" has the meaning given that term in section 509 of the Gramm-Leach-Bliley Act (15 U.S.C. 6809).',
      ),
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      title: 15,
      section: '6809',
      citation: '15 U.S.C. 6809',
    });
    expect(targets[0]?.terms[0]).toMatchObject({
      term: 'financial institution',
      lookups: ['financial institution'],
      stated: true,
    });
  });

  it("uses the target section's own name for the term when the bill gives one", () => {
    const [target] = targetsIn([
      sec(
        'sec-2',
        'In this Act: (1) State chartered depository institution The term "State chartered depository institution" has the meaning given the term State depository institution in section 3(c) of the Federal Deposit Insurance Act (12 U.S.C. 1813(c)).',
      ),
    ]);
    expect(target?.citation).toBe('12 U.S.C. 1813');
    expect(target?.terms[0]?.lookups).toEqual([
      'State depository institution',
      'State chartered depository institution',
    ]);
  });

  it('accepts the other phrasings that name a U.S. Code section', () => {
    const targets = targetsIn([
      sec(
        'sec-2',
        'In this Act: (1) Agency The term "agency" has the same meaning as in section 551 of title 5, United States Code. (2) Widget The term "widget" has the meaning given in 42 U.S.C. 1395x. (3) Gadget The term "gadget" has the meaning given such term under section 7701(a)(1) of the Internal Revenue Code of 1986 (26 U.S.C. 7701(a)(1)).',
      ),
    ]);
    expect(targets.map((t) => t.citation).sort()).toEqual([
      '26 U.S.C. 7701',
      '42 U.S.C. 1395x',
      '5 U.S.C. 551',
    ]);
  });

  it('collects several terms read from the same section, once each', () => {
    const [target] = targetsIn([
      sec(
        'sec-2',
        'In this Act: (1) Branch The term "Federal branch" has the meaning given that term in section 3 of the Federal Deposit Insurance Act (12 U.S.C. 1813). (2) Sub The term "subsidiary" has the meaning given that term in section 3 of the Federal Deposit Insurance Act (12 U.S.C. 1813).',
      ),
    ]);
    expect(target?.terms.map((t) => t.term)).toEqual([
      'Federal branch',
      'subsidiary',
    ]);
  });
});

describe('findDefinitionTargets: guessed from "(as defined in ...)"', () => {
  it('reads the words before the aside as candidate terms, longest first', () => {
    const [target] = targetsIn([
      sec(
        'sec-3',
        'The bank is an insured depository institution (as defined in section 3 of the Federal Deposit Insurance Act (12 U.S.C. 1813)) that holds a charter.',
      ),
    ]);
    expect(target?.citation).toBe('12 U.S.C. 1813');
    expect(target?.terms[0]).toMatchObject({
      stated: false,
      term: 'insured depository institution',
    });
    expect(target?.terms[0]?.lookups).toContain(
      'insured depository institution',
    );
    expect(target?.terms[0]?.lookups).toContain('institution');
  });

  it('also reads ", as defined in" after a comma', () => {
    const [target] = targetsIn([
      sec(
        'sec-3',
        'It is a security, as defined in section 2 of the Securities Act of 1933 (15 U.S.C. 77b).',
      ),
    ]);
    expect(target?.citation).toBe('15 U.S.C. 77b');
    expect(target?.terms[0]?.lookups[0]).toBe('security');
  });
});

describe('findDefinitionTargets: what it must not follow', () => {
  it.each([
    // No citation after the phrase.
    [
      'The term "widget" has the meaning given that term in section 509 of the Gramm-Leach-Bliley Act.',
    ],
    // A definition of the bill's own, with a citation unrelated to a meaning.
    ['The term "widget" means a device regulated under 15 U.S.C. 6809.'],
    // The citation is in the next clause, not the pointer.
    [
      'The term "widget" has the meaning given in this Act; the Secretary shall act under 15 U.S.C. 6809.',
    ],
    // A pointer into the Ohio Revised Code is not the U.S. Code.
    [
      'The term "widget" has the meaning given that term in section 3501.01 of the Revised Code.',
    ],
    // A pointer to this very bill.
    [
      'The term "widget" has the meaning given that term in section 2 of this Act.',
    ],
    // A citation too far away to belong to the phrase.
    [
      `The term "widget" has the meaning given that term in ${'the long text of a clause '.repeat(10)} 15 U.S.C. 6809.`,
    ],
  ])('%s', (text) => {
    expect(
      targetsIn([sec('sec-2', `In this Act: (1) Widget ${text}`)]),
    ).toEqual([]);
  });

  it('ignores struck text', () => {
    const section = sec('sec-2', '', {
      spans: [
        {
          text: 'The term "widget" has the meaning given that term in section 509 (15 U.S.C. 6809).',
          status: 'deleted',
        },
      ],
    });
    expect(targetsIn([section])).toEqual([]);
  });
});

describe('findDefinitionTargets: caps', () => {
  it(`keeps at most ${String(MAX_TARGETS)} sections, those with stated terms first`, () => {
    const lines = Array.from(
      { length: 12 },
      (_, n) =>
        `(${String(n + 1)}) T${String(n)} The term "t${String(n)}" has the meaning given that term in section ${String(n + 1)} of title 15, United States Code.`,
    ).join(' ');
    const guess =
      'A gizmo (as defined in section 9 of the Gizmo Act (15 U.S.C. 9000)) exists.';
    const targets = findDefinitionTargets(
      [sec('sec-1', guess), sec('sec-2', `In this Act: ${lines}`)],
      docOf([]).definitions.concat(
        extractDefinitions(
          [sec('sec-2', `In this Act: ${lines}`)],
          buildSectionIndex([sec('sec-2', `In this Act: ${lines}`)]),
        ),
      ),
    );
    expect(targets).toHaveLength(MAX_TARGETS);
    expect(targets.every((t) => t.terms.some((term) => term.stated))).toBe(
      true,
    );
  });
});

describe('findDefinitionTargets: shapes seen in real bills', () => {
  it('reads a nested "(I) has the meaning given that term in ..." under "The term X —"', () => {
    const [target] = targetsIn([
      sec(
        'sec-2',
        'In this paragraph: (i) Financial activities The term financial activities— (I) has the meaning given that term in section 4(k) of the Bank Holding Company Act of 1956 (12 U.S.C. 1843(k)); and (II) includes more.',
      ),
    ]);
    expect(target).toMatchObject({ citation: '12 U.S.C. 1843' });
    expect(target?.terms[0]?.term).toBe('financial activities');
  });

  it('stays fast on long runs of spaces, commas and parentheses', () => {
    const noise = `${' ,('.repeat(20_000)}x`;
    const started = Date.now();
    targetsIn([
      sec('sec-2', `${noise} (as defined in ${noise}`),
      sec('sec-3', `The term "a" has the meaning given the term ${noise}`),
    ]);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
