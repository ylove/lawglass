import { describe, expect, it } from 'vitest';
import type { Section } from '../model/index.js';
import {
  chooseBreakdownUnits,
  isBoilerplate,
  MAX_BREAKDOWN_UNITS,
  subtreeText,
} from './units.js';

function section(
  id: string,
  heading: string | undefined,
  text: string,
  children: Section[] = [],
): Section {
  return {
    id,
    num: id.replace(/^sec-/, ''),
    ...(heading === undefined ? {} : { heading }),
    level: 1,
    spans: text ? [{ text, status: 'unchanged' }] : [],
    children,
  };
}

const SUBSTANTIVE = 'The department shall award grants to eligible towns.';

describe('isBoilerplate', () => {
  it.each([
    'Short title',
    'Short title.',
    'SHORT  TITLE',
    'Table of contents',
    'Short title; table of contents',
    'Severability',
    'Rule of construction',
    'Rules of Construction',
    'Effective date',
    'Definitions',
    'Definitions and effective date',
  ])('skips the heading "%s"', (heading) => {
    expect(isBoilerplate(section('sec-1', heading, SUBSTANTIVE))).toBe(true);
  });

  it.each([
    'Grants',
    'Definitions of eligible entities and grant amounts',
    'Effective date of the grant program rules and penalties',
  ])('keeps the heading "%s"', (heading) => {
    expect(isBoilerplate(section('sec-1', heading, SUBSTANTIVE))).toBe(false);
  });

  it('recognizes boilerplate with no heading by its opening words', () => {
    const skipped = [
      'This act may be cited as the Community Gardens Act.',
      'Table of contents. Sec. 1. Short title.',
      'If any provision of this act is held invalid, the rest of the act is not affected.',
      'As used in this section, the term "garden group" means a group.',
      'This act takes effect ninety days after passage.',
    ];
    for (const text of skipped)
      expect(isBoilerplate(section('sec-9', undefined, text))).toBe(true);
  });

  it('skips the preamble the parsers keep for text before the first section', () => {
    expect(
      isBoilerplate(section('preamble', undefined, 'A BILL to fund gardens.')),
    ).toBe(true);
    expect(isBoilerplate(section('preamble-2', undefined, SUBSTANTIVE))).toBe(
      true,
    );
    expect(isBoilerplate(section('preamble-notes', 'Notes', SUBSTANTIVE))).toBe(
      false,
    );
  });

  it('keeps a long section that merely mentions an effective date', () => {
    const text = `${SUBSTANTIVE} This section takes effect on July 1 and applies to every grant made after that date, including grants renewed under section 4.`;
    expect(isBoilerplate(section('sec-9', undefined, text))).toBe(false);
  });

  it('judges a parent by its whole subtree', () => {
    const parent = section('sec-5', 'Reports', '', [
      section('sec-5/a', undefined, SUBSTANTIVE),
    ]);
    expect(subtreeText(parent)).toContain('grants');
    expect(isBoilerplate(parent)).toBe(false);
  });
});

describe('chooseBreakdownUnits', () => {
  it('skips boilerplate and keeps document order', () => {
    const { units, omitted } = chooseBreakdownUnits([
      section('sec-1', 'Short title', 'This act may be cited as the X Act.'),
      section('sec-2', 'Definitions', 'In this act, "town" means a town.'),
      section('sec-3', 'Grants', SUBSTANTIVE),
      section('sec-4', 'Reports', 'The department shall file a yearly report.'),
      section(
        'sec-5',
        'Severability',
        'If any part is held invalid, the rest stays.',
      ),
      section('sec-6', 'Effective date', 'This act takes effect July 1, 2027.'),
    ]);
    expect(units.map((u) => u.id)).toEqual(['sec-3', 'sec-4']);
    expect(omitted).toBe(0);
  });

  it('opens divisions and titles, which have no text of their own', () => {
    const { units } = chooseBreakdownUnits([
      section('division-a', 'Division A', '', [
        section(
          'division-a/sec-1',
          'Short title',
          'This act may be cited as the X Act.',
        ),
        section('division-a/sec-2', 'Grants', SUBSTANTIVE),
      ]),
      section('division-b', 'Division B', '', [
        section(
          'division-b/sec-3',
          'Fees',
          'The department shall charge a fee of $5.',
        ),
      ]),
    ]);
    expect(units.map((u) => u.id)).toEqual([
      'division-a/sec-2',
      'division-b/sec-3',
    ]);
  });

  it('skips a part with no text anywhere in it', () => {
    const { units } = chooseBreakdownUnits([
      section('sec-1', 'Grants', SUBSTANTIVE),
      section('sec-2', 'Empty', ''),
    ]);
    expect(units.map((u) => u.id)).toEqual(['sec-1']);
  });

  it('keeps a wholly struck part: the bill removes something', () => {
    const struck: Section = {
      ...section('sec-2', 'Old fee', ''),
      spans: [{ text: 'A fee of $5 is charged.', status: 'deleted' }],
    };
    const { units } = chooseBreakdownUnits([
      struck,
      section('sec-3', 'Grants', SUBSTANTIVE),
    ]);
    expect(units.map((u) => u.id)).toEqual(['sec-2', 'sec-3']);
  });

  it('caps the list and reports how many substantive parts were left out', () => {
    const many = Array.from({ length: MAX_BREAKDOWN_UNITS + 7 }, (_, i) =>
      section(`sec-${String(i + 1)}`, `Topic ${String(i + 1)}`, SUBSTANTIVE),
    );
    const { units, omitted } = chooseBreakdownUnits(many);
    expect(units).toHaveLength(MAX_BREAKDOWN_UNITS);
    expect(units[0]?.id).toBe('sec-1');
    expect(omitted).toBe(7);
  });

  it('returns nothing for a bill that is all boilerplate', () => {
    const { units } = chooseBreakdownUnits([
      section('sec-1', 'Short title', 'This act may be cited as the X Act.'),
    ]);
    expect(units).toEqual([]);
  });
});
