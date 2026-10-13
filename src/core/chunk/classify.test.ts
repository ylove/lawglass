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
    ['This provision shall take effect tomorrow.', '', 'effective_date'],
    ['This provision is effective immediately.', '', 'effective_date'],
    ['This provision shall take effective January 1.', '', 'effective_date'],
    ['This provision shall become effective tomorrow.', '', 'effective_date'],
    ['This provision is effective on January 1.', '', 'effective_date'],
    ['This provision is effective upon enactment.', '', 'effective_date'],
    ['This provision is effective beginning January 1.', '', 'effective_date'],
    ['This provision is effective as of January 1.', '', 'effective_date'],
    ['The effective date is January 1.', '', 'effective_date'],
    ['This provision is operative on January 1.', '', 'effective_date'],
    ['This provision is operative upon enactment.', '', 'effective_date'],
    ['The operative date is January 1.', '', 'effective_date'],
    ['This provision is operative tomorrow.', '', 'operative'],
    [
      'The operative provisions of this section apply to towns.',
      '',
      'operative',
    ],
    ['The act shall apply in January.', 'Effective date', 'effective_date'],
    ['There is appropriated $100.', '', 'appropriation'],
    ['There is authorized an annual grant.', '', 'operative'],
    ['The state shall appropriate money for grants.', '', 'appropriation'],
    ['The appropriation supports towns.', '', 'appropriation'],
    ['There is authorized to be appropriated $100.', '', 'appropriation'],
    [
      'There is hereby authorized to be appropriated $100.',
      '',
      'appropriation',
    ],
    ['$100 is hereby appropriated.', '', 'appropriation'],
    ['$100 shall be paid from the general fund.', '', 'appropriation'],
    ['From the fund, 100 dollars shall be paid.', '', 'appropriation'],
    ['From the general fund, 2 million shall be paid.', '', 'appropriation'],
    ['The general fund shall pay.', '', 'operative'],
    ['A fee of $5 is due.', '', 'operative'],
    [
      'The Secretary may not impose a fee of $20 on applicants.',
      '',
      'operative',
    ],
    ['A tax of $100 is due.', '', 'operative'],
    ['The cost is $20.', '', 'operative'],
    ['The agency administers funds.', '', 'operative'],
    ['Records shall be maintained from the general fund.', '', 'operative'],
    ['The general fund has 20 applicants.', '', 'operative'],
    ['Applicants shall submit forms.', 'Appropriations', 'appropriation'],
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

  it('classifies amendments to penalty provisions as penalties even with a non-penalty heading', () => {
    expect(
      classifyChunk(
        'This act amends the penalty provision of prior law.',
        'Administration',
      ),
    ).toBe('penalty');
  });

  it('applies specific heuristics in priority order', () => {
    expect(
      classifyChunk('"Fine" means $100 payable on the effective date.'),
    ).toBe('definition');
    expect(classifyChunk('A violation carries a fine of $100.')).toBe(
      'penalty',
    );
    expect(
      classifyChunk(
        'Effective immediately, $100 is appropriated.',
        'Penalties',
      ),
    ).toBe('penalty');
    expect(classifyChunk('The fund takes effect tomorrow.')).toBe(
      'effective_date',
    );
    expect(classifyChunk('The purpose is to appropriate money.')).toBe(
      'appropriation',
    );
  });
});
