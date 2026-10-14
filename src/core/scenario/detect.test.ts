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

describe('wantsScenario', () => {
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
