import { describe, expect, it } from 'vitest';
import { classifyChunk } from './classify.js';

describe('classifyChunk', () => {
  it.each([
    ['Applicants may apply.', 'Definitions', 'definition'],
    ['“Resident” means a person living here.', '', 'definition'],
    ['The term resident means a person living here.', '', 'definition'],
    ['As used in this act, town includes villages.', '', 'definition'],
    ['"Town" includes villages.', '', 'definition'],
    ['A person is guilty of an offense.', '', 'penalty'],
    ['A violation carries a fine.', '', 'penalty'],
    ['Imprisonment is required.', '', 'penalty'],
    ['Applicants shall submit forms.', 'Penalties', 'penalty'],
    ['The act takes effect in January.', '', 'effective_date'],
    ['This provision is operative tomorrow.', '', 'effective_date'],
    ['The act shall apply in January.', 'Effective date', 'effective_date'],
    ['There is appropriated $100.', '', 'appropriation'],
    ['There is authorized an annual grant.', '', 'appropriation'],
    ['The general fund shall pay.', '', 'appropriation'],
    ['A fee of $5 is due.', '', 'appropriation'],
    ['The Congress finds that towns need aid.', '', 'findings'],
    ['The purpose is to assist towns.', '', 'findings'],
    ['Towns need assistance.', 'Findings', 'findings'],
    ['This act may be cited as the Town Act.', '', 'other'],
    ['Be it enacted.', '', 'other'],
    ['Town Act.', 'Short title', 'other'],
    ['Applicants shall file forms.', '', 'operative'],
    ['A refined funding mechanism is established.', '', 'operative'],
    ['The committee is effective at assisting communities.', '', 'operative'],
    ['May be cited '.repeat(20), '', 'operative'],
  ])('classifies %j under %j as %s', (text, heading, expected) => {
    expect(classifyChunk(text, heading)).toBe(expected);
  });

  it('applies specific heuristics in priority order', () => {
    expect(
      classifyChunk('"Fine" means $100 payable on the effective date.'),
    ).toBe('definition');
    expect(classifyChunk('A violation carries a fine of $100.')).toBe(
      'penalty',
    );
    expect(classifyChunk('The fund takes effect tomorrow.')).toBe(
      'effective_date',
    );
    expect(classifyChunk('The purpose is to establish a fund.')).toBe(
      'appropriation',
    );
  });
});
