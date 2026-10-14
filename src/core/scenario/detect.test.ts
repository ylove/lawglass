import { describe, expect, it } from 'vitest';
import type { Section } from '../model/index.js';
import { classifyBill, OMNIBUS_MAX_SECTIONS, wantsScenario } from './detect.js';

function section(
  id: string,
  heading: string,
  children: Section[] = [],
): Section {
  return {
    id,
    num: id,
    heading,
    level: 1,
    spans:
      children.length === 0
        ? [{ text: 'Body text.', status: 'unchanged' }]
        : [],
    children,
  } as unknown as Section;
}
const leaves = (headings: string[]): Section[] =>
  headings.map((h, i) => section(`sec-${String(i + 1)}`, h));

describe('classifyBill', () => {
  it('treats a short bill as single-subject', () => {
    expect(
      classifyBill(leaves(['Rent increase limits', 'Notice to tenants'])),
    ).toBe('single-subject');
  });

  it('treats a long bill with one recurring heading word as single-subject', () => {
    const headings = [
      'Short title',
      'Tax credit for solar',
      'Solar credit amount',
      'Solar installation rules',
      'Eligible solar property',
      'Solar credit limits',
      'Claiming the credit',
      'Definitions',
      'Effective date',
    ];
    expect(classifyBill(leaves(headings))).toBe('single-subject');
  });

  it('treats a long bill with scattered headings as omnibus', () => {
    const headings = [
      'Bridge repair',
      'School lunches',
      'Wildfire grants',
      'Tax filing dates',
      'Port security',
      'Rural broadband',
      'Veterans housing',
    ];
    expect(classifyBill(leaves(headings))).toBe('omnibus');
  });

  it('treats three divisions as omnibus even when each is small', () => {
    const divisions = ['A', 'B', 'C'].map((d) =>
      section(`div-${d}`, `Division ${d}`, [
        section(`sec-${d}1`, 'Water rules'),
      ]),
    );
    expect(classifyBill(divisions)).toBe('omnibus');
  });

  it('descends through up to two divisions and still counts as focused', () => {
    const divisions = ['A', 'B'].map((d) =>
      section(`div-${d}`, `Division ${d}`, [
        section(`sec-${d}1`, 'Water rules'),
      ]),
    );
    expect(classifyBill(divisions)).toBe('single-subject');
  });

  it('treats a very long bill as omnibus whatever its headings', () => {
    const many = Array.from(
      { length: OMNIBUS_MAX_SECTIONS + 1 },
      () => 'Water rules',
    );
    expect(classifyBill(leaves(many))).toBe('omnibus');
  });

  it('has no basis for a story when only boilerplate sections exist', () => {
    expect(classifyBill(leaves(['Short title', 'Definitions']))).toBe(
      'omnibus',
    );
    expect(classifyBill([])).toBe('omnibus');
  });

  it('tolerates sections without headings', () => {
    const unheaded = Array.from({ length: 8 }, (_, i) => ({
      ...section(`sec-${String(i)}`, ''),
      heading: undefined,
    }));
    expect(classifyBill(unheaded)).toBe('omnibus');
  });
});

/** Heading-less sections shaped like a parsed Ohio bill: code sections carry only a number. */
const ohio = (...codes: string[]): Section[] =>
  [
    {
      id: 'preamble',
      level: 1,
      spans: [{ text: 'x', status: 'unchanged' }],
      children: [],
    },
    {
      id: 'sec-1',
      num: '1',
      heading: 'That sections be amended',
      level: 1,
      spans: [{ text: 'x', status: 'unchanged' }],
      children: [],
    },
    ...codes.map((c) => ({
      id: `sec-${c}`,
      num: c,
      level: 1,
      spans: [{ text: 'x', status: 'unchanged' }],
      children: [],
    })),
    {
      id: 'sec-2',
      num: '2',
      heading: 'That existing sections are repealed',
      level: 1,
      spans: [{ text: 'x', status: 'unchanged' }],
      children: [],
    },
  ] as unknown as Section[];

describe('classifyBill on heading-less (Ohio-style) bills', () => {
  it('treats a focused 8-section school bill as single-subject', () => {
    expect(
      classifyBill(
        ohio(
          '3313.475',
          '3314.03',
          '3314.08',
          '3326.11',
          '3328.24',
          '3317.02',
          '3319.11',
          '3313.60',
        ),
      ),
    ).toBe('single-subject');
  });

  it('treats a mixed-title bill as omnibus', () => {
    expect(
      classifyBill(
        ohio(
          '2901.05',
          '3314.03',
          '4511.19',
          '5747.01',
          '1707.01',
          '3701.34',
          '4123.01',
          '5101.80',
        ),
      ),
    ).toBe('omnibus');
  });

  it('accepts one dominant chapter even when titles are mixed', () => {
    expect(
      classifyBill(
        ohio(
          '3314.01',
          '3314.02',
          '3314.03',
          '3314.04',
          '2901.1',
          '5747.1',
          '4511.1',
          '1707.1',
        ),
      ),
    ).toBe('single-subject');
  });

  it('judges a short bill by title share too', () => {
    expect(classifyBill(ohio('2307.601', '2901.05', '2901.09'))).toBe(
      'single-subject',
    );
    expect(classifyBill(ohio('2307.601', '3314.05', '5747.09'))).toBe(
      'omnibus',
    );
  });

  it('is omnibus when a long bill has neither headings nor code numbers', () => {
    const bare = Array.from({ length: 8 }, (_, i) => ({
      id: `s${String(i)}`,
      level: 1,
      spans: [],
      children: [],
    }));
    expect(classifyBill(bare)).toBe('omnibus');
  });

  it('handles three-digit chapters (title is the first digit)', () => {
    expect(
      classifyBill(
        ohio(
          '109.57',
          '109.572',
          '121.22',
          '149.43',
          '101.1',
          '102.2',
          '103.3',
        ),
      ),
    ).toBe('single-subject');
  });
});

describe('wantsScenario', () => {
  it.each([
    "I'm a renter, what changes for me?",
    'Will my property taxes go up?',
    'What changes for homeowners?',
    "How will this change my county's tax rate?",
    'What is in it for me?',
    'Does this help me?',
  ])('also says yes to %s', (question) => {
    expect(wantsScenario(question)).toBe(true);
  });

  it.each([
    'Does this bill help us understand the issue?',
    'Which agency helps the court decide?',
  ])('says no to %s', (question) => {
    expect(wantsScenario(question)).toBe(false);
  });

  it.each([
    'How will this affect me?',
    'Does this apply to my family?',
    'What does this mean for renters?',
    'How do businesses respond to the new rule?',
    'Would I pay more tax?',
    'Will I still qualify for the credit?',
    'What does this mean for my small business?',
    'How are families affected?',
    'What does the bill mean for the household?',
    'What would this do for my rent',
  ])('says yes to %s', (question) => {
    expect(wantsScenario(question)).toBe(true);
  });

  it.each([
    'What does section 3 say?',
    'When does it take effect?',
    'What is the penalty for a late filing?',
    'Who sponsored this bill?',
    'Define the term utility.',
    '',
  ])('says no to %s', (question) => {
    expect(wantsScenario(question)).toBe(false);
  });
});
