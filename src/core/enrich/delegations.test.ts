import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadsDirectory } from '../../../scripts/fixture-manifest.js';
import {
  describeWithFixture,
  fixturePath,
} from '../../../tests/support/fixtures.js';
import type { ExternalRef, Section } from '../model/index.js';
import { parsePdf, parseXml } from '../parse/index.js';
import { chunkDocument } from '../chunk/index.js';
import {
  GROUP_CAP,
  afterLastConjunction,
  extractDelegations,
} from './delegations.js';
import { sec } from './fixtures.js';
import { enrichDocument } from './index.js';

const decided = (text: string) =>
  extractDelegations([sec('s', text)]).decidedLater;
const depends = (text: string) =>
  extractDelegations([sec('s', text)]).dependsOn;
const effect = (text: string) =>
  extractDelegations([sec('s', text)]).takesEffect;

describe('decided later: rule-making and discretion', () => {
  it('finds "shall prescribe regulations" with actor and deadline', () => {
    const [item] = decided(
      'Not later than 180 days after the date of enactment of this Act, the Secretary of Education shall prescribe regulations to carry out this section.',
    );
    expect(item).toMatchObject({
      sectionId: 's',
      kind: 'rulemaking',
      actor: 'the Secretary of Education',
      deadline:
        'Not later than 180 days after the date of enactment of this Act',
    });
    expect(item?.what).toBe('prescribe regulations to carry out this section');
    expect(item?.quote).toContain('shall prescribe regulations');
  });

  it.each([
    [
      'promulgate',
      'The Administrator shall promulgate such rules as are needed.',
    ],
    [
      'adopt',
      'The director of commerce shall adopt rules in accordance with Chapter 119.',
    ],
    ['issue', 'The Commission shall issue final regulations.'],
  ])('finds rule-making verb: %s', (_n, text) => {
    expect(decided(text)).toHaveLength(1);
    expect(decided(text)[0]?.kind).toBe('rulemaking');
  });

  it('finds "shall establish" standards, criteria, procedures', () => {
    const items = decided(
      'The board of elections shall establish uniform procedures for recounts.',
    );
    expect(items[0]).toMatchObject({
      kind: 'standards',
      actor: 'The board of elections',
    });
  });

  it('skips a modifier clause to find the subject', () => {
    const [item] = decided(
      'The Secretary, in consultation with the Administrator, shall prescribe regulations.',
    );
    expect(item?.actor).toBe('The Secretary');
  });

  it('strips a leading label', () => {
    const [item] = decided(
      '(b) Rulemaking.—The Secretary shall promulgate regulations.',
    );
    expect(item?.actor).toBe('The Secretary');
  });

  it('finds "as the X determines appropriate"', () => {
    const [item] = decided(
      'Grants shall be spent on training, as the Secretary determines appropriate.',
    );
    expect(item).toMatchObject({
      kind: 'determination',
      actor: 'the Secretary',
      what: 'Grants shall be spent on training',
    });
  });

  it('finds "as determined by" an official body', () => {
    const [item] = decided(
      'The amount of the payment, as determined by the Commissioner of Social Security, is final.',
    );
    expect(item).toMatchObject({
      kind: 'determination',
      actor: 'the Commissioner of Social Security',
    });
  });

  it("finds an official's waiver, active and passive", () => {
    expect(
      decided('The Secretary may waive the requirement.')[0],
    ).toMatchObject({
      kind: 'waiver',
      actor: 'The Secretary',
    });
    expect(
      decided(
        'The requirement may be waived by the Director of the Office.',
      )[0],
    ).toMatchObject({ kind: 'waiver', actor: 'the Director of the Office' });
  });

  it('finds discretion and approval', () => {
    expect(
      decided('Funds are released at the discretion of the council.')[0],
    ).toMatchObject({ kind: 'discretion', actor: 'the council' });
    expect(
      decided('The plan is final, subject to the approval of the Governor.')[0],
    ).toMatchObject({ kind: 'approval', actor: 'the Governor' });
  });

  it("finds an official's designation", () => {
    expect(
      decided('The Mayor shall designate a coordinator.')[0],
    ).toMatchObject({
      kind: 'designation',
      actor: 'The Mayor',
    });
  });

  it('leaves the actor out when it cannot be read reliably', () => {
    const [item] = decided(
      'It is the intent of the General Assembly and the people of this great State and everyone shall prescribe rules.',
    );
    expect(item?.actor).toBeUndefined();
  });

  describe('negatives', () => {
    it.each([
      ['plain duty', 'The board of elections shall certify the results.'],
      [
        'plain duty with report',
        'The Secretary shall submit a report to Congress.',
      ],
      ['public permission', 'A person may file a complaint with the board.'],
      ['public waiver', 'A person may waive the right to a hearing.'],
      ['applicant waiver passive', 'The right may be waived by the applicant.'],
      ['private designation', 'Each applicant shall designate a beneficiary.'],
      ['establishing a fund', 'The Treasurer shall establish a fund.'],
      ['negated', 'The Secretary shall not prescribe regulations.'],
      ['may not waive', 'The Secretary may not waive the requirement.'],
      ['determined by a court', 'Damages, as determined by a court, are owed.'],
      [
        'determined by a section',
        'The rate, as determined by section 5, applies.',
      ],
      [
        'determined by a method',
        'The sum, as determined by dividing the total by two.',
      ],
      [
        'discretion of the court',
        'Fees are awarded in the discretion of the court.',
      ],
      [
        'approval of the voters',
        'This is subject to the approval of the voters.',
      ],
      [
        'rulemaking noun',
        'The Secretary shall issue a notice of proposed rulemaking.',
      ],
    ])('excludes %s', (_n, text) => {
      expect(decided(text)).toEqual([]);
    });

    it('excludes struck text', () => {
      const s: Section = {
        id: 's',
        level: 1,
        children: [],
        spans: [
          { text: 'The Secretary ', status: 'unchanged' },
          { text: 'shall prescribe regulations. ', status: 'deleted' },
          { text: 'shall report annually.', status: 'unchanged' },
        ],
      };
      expect(extractDelegations([s]).decidedLater).toEqual([]);
    });

    it('keeps inserted text', () => {
      const s: Section = {
        id: 's',
        level: 1,
        children: [],
        spans: [
          { text: 'The director ', status: 'unchanged' },
          { text: 'shall adopt rules.', status: 'inserted' },
        ],
      };
      expect(extractDelegations([s]).decidedLater).toHaveLength(1);
    });

    it('excludes a definition', () => {
      const text =
        'In this section:\n"Designator" means the officer who shall designate a coordinator and shall adopt rules.';
      expect(decided(text)).toEqual([]);
    });
  });
});

describe('depends on', () => {
  it('finds appropriation limits', () => {
    expect(
      depends(
        'Grants are made subject to the availability of appropriations.',
      )[0],
    ).toMatchObject({ kind: 'appropriation' });
    expect(
      depends('This applies to the extent funds are available.')[0],
    ).toMatchObject({ kind: 'appropriation' });
    expect(
      depends('Subject to appropriations, the program expands.')[0],
    ).toMatchObject({ kind: 'appropriation' });
  });

  it('does not treat an authorization of appropriations as a dependency', () => {
    expect(
      depends('There is authorized to be appropriated $5,000,000.'),
    ).toEqual([]);
  });

  it('finds voter approval', () => {
    expect(
      depends(
        'The charter amendment takes effect if approved by a majority of the electors voting on it.',
      ).map((i) => i.kind),
    ).toContain('voter_approval');
    expect(
      depends(
        'The question shall be submitted to the qualified electors of the city.',
      )[0],
    ).toMatchObject({ kind: 'voter_approval' });
  });

  it('finds contingency triggers', () => {
    expect(
      depends(
        'Section 4 takes effect only if Congress enacts the companion bill.',
      )[0],
    ).toMatchObject({ kind: 'contingency' });
    expect(
      depends('This section is contingent upon the enactment of H.R. 5.')[0],
    ).toMatchObject({ kind: 'contingency' });
  });

  it('finds an outside body that approves', () => {
    expect(
      depends('The program must be approved by the Department of Labor.')[0],
    ).toMatchObject({
      kind: 'outside_body',
      actor: 'the Department of Labor',
    });
    expect(
      depends('Done with the written concurrence of the Governor.')[0],
    ).toMatchObject({
      kind: 'outside_body',
      actor: 'the Governor',
    });
    expect(depends('Reviewed by the Food and Drug Administration.')).toEqual(
      [],
    );
    expect(
      depends('Approved by the Food and Drug Administration before sale.')[0]
        ?.actor,
    ).toBe('the Food and Drug Administration');
  });

  it.each([
    ['approved by law', 'The fee is approved by law.'],
    [
      'approved by voters is not an outside body',
      'It was approved by the voters in 2020.',
    ],
    ['contingent fee', 'No contingent fees are allowed.'],
    ['court approval', 'The settlement must be approved by the court.'],
    ['struck', ''],
  ])('excludes %s', (_n, text) => {
    expect(depends(text).filter((i) => i.kind === 'outside_body')).toEqual([]);
    expect(depends(text).filter((i) => i.kind === 'contingency')).toEqual([]);
  });

  it('ignores appropriation words in struck text', () => {
    const s: Section = {
      id: 's',
      level: 1,
      children: [],
      spans: [
        { text: 'Pay now', status: 'unchanged' },
        { text: ', subject to appropriations', status: 'deleted' },
        { text: '.', status: 'unchanged' },
      ],
    };
    expect(extractDelegations([s]).dependsOn).toEqual([]);
  });

  describe('laws from the reference extractor', () => {
    const ref: ExternalRef = {
      text: 'section 5747.01 of the Revised Code',
      citation: 'R.C. 5747.01',
      kind: 'state_code',
      sectionIds: ['s'],
    };

    it('lists a cited law with its sentence', () => {
      const result = extractDelegations(
        [sec('s', 'Tax is levied as in section 5747.01 of the Revised Code.')],
        [ref],
      );
      expect(result.dependsOn[0]).toMatchObject({
        kind: 'law',
        actor: 'R.C. 5747.01',
        what: 'section 5747.01 of the Revised Code',
      });
    });

    it('drops a law cited only in struck text', () => {
      const s: Section = {
        id: 's',
        level: 1,
        children: [],
        spans: [
          { text: 'Tax is levied.', status: 'unchanged' },
          {
            text: ' See section 5747.01 of the Revised Code.',
            status: 'deleted',
          },
        ],
      };
      expect(extractDelegations([s], [ref]).dependsOn).toEqual([]);
    });

    it('lists laws after the other dependencies when the cap bites', () => {
      const refs: ExternalRef[] = Array.from({ length: 30 }, (_, i) => ({
        text: `section ${String(4000 + i)}.01 of the Revised Code`,
        citation: `R.C. ${String(4000 + i)}.01`,
        kind: 'state_code',
        sectionIds: ['s'],
      }));
      const text =
        'Grants follow ' +
        refs.map((r) => r.text).join(', ') +
        '. Spending is subject to appropriations.';
      const result = extractDelegations([sec('s', text)], refs);
      expect(result.dependsOn).toHaveLength(GROUP_CAP);
      expect(result.dependsOn[0]?.kind).toBe('appropriation');
      expect(result.truncated.dependsOn).toBe(31 - GROUP_CAP);
    });
  });
});

describe('takes effect', () => {
  it('finds effective-date phrases and what follows', () => {
    expect(
      effect('This Act shall take effect on January 1, 2027.')[0],
    ).toMatchObject({
      kind: 'effective_date',
      what: 'on January 1, 2027',
    });
    expect(
      effect('Effective upon the date of enactment, the fee applies.'),
    ).toHaveLength(1);
    expect(effect('Beginning on July 1, the fee applies.')).toHaveLength(1);
  });

  it('lists a conditional start only as a contingency', () => {
    const result = extractDelegations([
      sec('s', 'This section takes effect only if the voters approve it.'),
    ]);
    expect(result.takesEffect).toEqual([]);
    expect(result.dependsOn.map((i) => i.kind)).toContain('contingency');
  });

  it('ignores "beginning on" that only starts a measuring period', () => {
    expect(
      effect(
        'Grants cover the 1-year period beginning on the date of enactment.',
      ),
    ).toEqual([]);
  });

  it('ignores a plain mention of "effective date"', () => {
    expect(effect('The effective date is defined elsewhere.')).toEqual([]);
  });
});

describe('positions, quotes, caps', () => {
  it('reports the line and page of the span that holds the match', () => {
    const s: Section = {
      id: 's',
      level: 1,
      pageStart: 1,
      lineStart: 1,
      children: [],
      spans: [
        { text: 'Intro text here. ', status: 'unchanged', page: 2, line: 5 },
        { text: 'struck ', status: 'deleted', page: 2, line: 6 },
        {
          text: 'The Secretary shall prescribe regulations.',
          status: 'unchanged',
          page: 3,
          line: 9,
        },
      ],
    };
    expect(extractDelegations([s]).decidedLater[0]).toMatchObject({
      page: 3,
      line: 9,
    });
  });

  it('falls back to the section start and omits missing positions', () => {
    const withStart = extractDelegations([
      sec('s', 'The Secretary shall prescribe regulations.', {
        pageStart: 4,
        lineStart: 2,
      }),
    ]);
    expect(withStart.decidedLater[0]).toMatchObject({ page: 4, line: 2 });
    const none = extractDelegations([
      sec('s', 'The Secretary shall prescribe regulations.'),
    ]);
    expect(none.decidedLater[0]).not.toHaveProperty('line');
    expect(none.decidedLater[0]).not.toHaveProperty('page');
  });

  it('keeps quotes within 200 characters, centred on a long sentence', () => {
    const filler = 'word '.repeat(120);
    const [item] = decided(
      `${filler}and the Secretary shall prescribe regulations ${filler}.`,
    );
    expect(item?.quote.length).toBeLessThanOrEqual(200);
    expect(item?.quote).toContain('shall prescribe regulations');
  });

  it('finds items in child sections with their own ids, in document order', () => {
    const parent = sec('sec-1', 'The Secretary shall adopt rules.', {
      children: [sec('sec-1/a', 'The Mayor may waive the fee.', { level: 2 })],
    });
    expect(
      extractDelegations([parent]).decidedLater.map((i) => i.sectionId),
    ).toEqual(['sec-1', 'sec-1/a']);
  });

  it('folds the same decision found twice', () => {
    const result = extractDelegations([
      sec(
        's',
        'The Secretary shall adopt rules. The Secretary shall adopt rules.',
      ),
    ]);
    expect(result.decidedLater).toHaveLength(1);
    expect(result.truncated.decidedLater).toBe(0);
  });

  it('keeps distinct decisions by the same actor, each with its own deadline', () => {
    const result = extractDelegations([
      sec(
        's',
        'Within 30 days, the Secretary shall prescribe safety regulations. Within 90 days, the Secretary shall prescribe licensing regulations.',
      ),
    ]);
    expect(result.decidedLater.map((i) => i.deadline)).toEqual([
      'Within 30 days',
      'Within 90 days',
    ]);
  });

  it('caps each group and counts the rest', () => {
    const sections = Array.from({ length: 30 }, (_, i) =>
      sec(`s${String(i)}`, 'The Secretary shall adopt rules.'),
    );
    const result = extractDelegations(sections);
    expect(result.decidedLater).toHaveLength(GROUP_CAP);
    expect(result.truncated.decidedLater).toBe(30 - GROUP_CAP);
  });

  it('is empty for empty input', () => {
    expect(extractDelegations([])).toEqual({
      decidedLater: [],
      dependsOn: [],
      takesEffect: [],
      truncated: { decidedLater: 0, dependsOn: 0, takesEffect: 0 },
    });
    expect(extractDelegations([sec('s', '')]).decidedLater).toEqual([]);
  });

  it('keeps a U.S.C. citation inside its sentence', () => {
    const [item] = decided(
      'The Secretary shall prescribe regulations under the Act (7 U.S.C. 1 et seq.) within 30 days.',
    );
    expect(item?.deadline).toBe('within 30 days');
  });

  it('does not split on common abbreviations', () => {
    const [item] = decided(
      'The U.S. Secretary of Labor shall prescribe regulations.',
    );
    expect(item?.actor).toBe('The U.S. Secretary of Labor');
  });
});

describe('charter-style dependencies', () => {
  const tie =
    'A tie between candidates for any office shall be decided by lot under the direction of the election authorities, as provided by the general election laws of the state.';

  it('reads direction, outside body and the named law from the text itself', () => {
    const result = extractDelegations([sec('s', tie)]);
    expect(result.decidedLater).toHaveLength(1);
    expect(result.decidedLater[0]).toMatchObject({
      kind: 'direction',
      actor: 'the election authorities',
      what: 'A tie between candidates for any office shall be decided by lot',
    });
    expect(result.dependsOn.map((i) => [i.kind, i.actor])).toEqual([
      ['outside_body', 'the election authorities'],
      ['law', 'the general election laws of the state'],
    ]);
  });

  it.each([
    [
      'supervision',
      'Work proceeds under the supervision of the Director of Public Service.',
    ],
    ['control', 'Funds are held under the control of the Treasurer.'],
  ])('finds %s of an official body', (_n, text) => {
    expect(decided(text)[0]).toMatchObject({ kind: 'direction' });
  });

  it('excludes direction of a court or a private party', () => {
    expect(decided('Held under the direction of the court.')).toEqual([]);
    expect(decided('Done under the direction of the applicant.')).toEqual([]);
  });

  it.each([
    [
      'as provided by',
      'Terms are as provided by the Ohio Revised Code.',
      'the Ohio Revised Code',
    ],
    [
      'in accordance with',
      'Do so in accordance with the municipal ordinances of the city.',
      'the municipal ordinances of the city',
    ],
    [
      'pursuant to',
      'Pursuant to the state election statutes, ballots are counted.',
      'the state election statutes',
    ],
    [
      'standalone phrase',
      'Disputes follow the general laws of the state.',
      'the general laws of the state',
    ],
  ])('finds a named law: %s', (_n, text, actor) => {
    expect(depends(text).map((i) => [i.kind, i.actor])).toContainEqual([
      'law',
      actor,
    ]);
  });

  it.each([
    [
      'division of this section',
      'Fees are set as provided in division (B) of this section.',
    ],
    [
      'section of this charter',
      'Fees are set as provided in section 3 of this charter.',
    ],
    ['this Act', 'Done in accordance with this Act.'],
    ['bare law', 'Done as provided by law.'],
    ['the Act', 'Done pursuant to the Act.'],
    ['not a law', 'Done in accordance with the following procedure.'],
    ['section of a code', 'Done pursuant to section 3 of the Revised Code.'],
  ])('excludes an internal or unnamed reference: %s', (_n, text) => {
    expect(depends(text).filter((i) => i.kind === 'law')).toEqual([]);
  });

  it('treats "<official> determines" as a determination', () => {
    const [item] = decided(
      'No petition is final until after the city clerk determines the sufficiency of the same.',
    );
    expect(item).toMatchObject({
      kind: 'determination',
      actor: 'the city clerk',
      what: 'determines the sufficiency of the same',
    });
  });

  it('drops an adverb between the official and "determines"', () => {
    expect(
      decided(
        'Exclude entities that the Administrator otherwise determines should be excluded.',
      )[0]?.actor,
    ).toBe('the Administrator');
  });

  it('does not double-list "as the X determines appropriate"', () => {
    expect(
      decided('Funds go to training, as the Secretary determines appropriate.'),
    ).toHaveLength(1);
  });

  it.each([
    ['court', 'The court determines the amount owed.'],
    ['private party', 'The applicant determines the date of the meeting.'],
    ['no subject', 'Whether it applies determines the outcome.'],
  ])('excludes "determines" with %s', (_n, text) => {
    expect(decided(text)).toEqual([]);
  });
});

describe('review fixes', () => {
  it.each([
    ['no regulations', 'The Secretary shall prescribe no regulations.'],
    ['neither', 'The Secretary shall adopt neither regulations nor rules.'],
    ['none', 'The Board shall issue none of the rules.'],
  ])('does not read a negative quantifier as rule-making: %s', (_n, text) => {
    expect(decided(text)).toEqual([]);
  });

  it('still reads one descriptive word before regulations', () => {
    expect(
      decided('The Secretary shall prescribe safety regulations.'),
    ).toHaveLength(1);
  });

  it.each([
    [
      'not required to be approved',
      'The program is not required to be approved by the Department of Labor.',
    ],
    [
      'not needed to be approved',
      'It is not necessary to be approved by the Governor.',
    ],
  ])('ignores a negated requirement: %s', (_n, text) => {
    expect(depends(text)).toEqual([]);
  });

  it.each([
    'This Act shall not become effective on January 1, 2027.',
    'This Act shall not take effect on January 1, 2027.',
  ])('ignores a negated effective date: %s', (text) => {
    expect(effect(text)).toEqual([]);
  });

  it.each([
    ['appropriation', 'The program is not subject to appropriations.'],
    [
      'outside body',
      'The program need not be approved by the Department of Labor.',
    ],
    ['approval', 'The plan is not subject to the approval of the Governor.'],
    ['voters', 'The plan is not subject to the approval of the voters.'],
    ['contingency', 'This section does not take effect if Congress objects.'],
  ])('ignores a negated dependency: %s', (_n, text) => {
    const result = extractDelegations([sec('s', text)]);
    expect(result.dependsOn).toEqual([]);
    expect(result.decidedLater).toEqual([]);
  });

  it('still finds the un-negated forms', () => {
    expect(depends('The program is subject to appropriations.')).toHaveLength(
      1,
    );
    expect(
      decided('The plan is subject to the approval of the Governor.'),
    ).toHaveLength(1);
  });

  it("finds an official's active approval and discretionary designation", () => {
    expect(decided('The Director may approve applications.')[0]).toMatchObject({
      kind: 'approval',
      actor: 'The Director',
    });
    expect(decided('The Board shall approve the plan.')[0]).toMatchObject({
      kind: 'approval',
    });
    expect(
      decided('The Secretary may designate a lead agency.')[0],
    ).toMatchObject({
      kind: 'designation',
      actor: 'The Secretary',
    });
  });

  it.each([
    ['applicant approves', 'An applicant may approve the terms.'],
    ['person designates', 'A person may designate a beneficiary.'],
    ['negated', 'The Director may not approve applications.'],
  ])('excludes public or negated approve/designate: %s', (_n, text) => {
    expect(decided(text)).toEqual([]);
  });

  it('turns "subject to the approval of the voters" into a voter-approval dependency', () => {
    const result = extractDelegations([
      sec(
        's',
        'The charter amendment is subject to the approval of the voters.',
      ),
    ]);
    expect(result.decidedLater).toEqual([]);
    expect(result.dependsOn.map((i) => i.kind)).toEqual(['voter_approval']);
  });

  it('finds a citation by its normalized form when a section words it differently', () => {
    const refs: ExternalRef[] = [
      {
        text: 'division (A) of section 5747.01 of the Revised Code',
        citation: 'R.C. 5747.01',
        kind: 'state_code',
        sectionIds: ['a', 'b'],
      },
    ];
    const result = extractDelegations(
      [
        sec('a', 'See division (A) of section 5747.01 of the Revised Code.'),
        sec('b', 'Tax follows section 5747.01 of the Revised Code.'),
      ],
      refs,
    );
    expect(result.dependsOn.map((i) => [i.sectionId, i.what])).toEqual([
      ['a', 'division (A) of section 5747.01 of the Revised Code'],
      ['b', 'section 5747.01 of the Revised Code'],
    ]);
  });

  describe('adversarial input stays fast', () => {
    const bound = 2000;
    const timed = (text: string): number => {
      const start = performance.now();
      extractDelegations([sec('s', text)]);
      return performance.now() - start;
    };

    it.each([
      [
        'repeated clause words',
        'that '.repeat(128000) + 'the Secretary shall prescribe regulations.',
      ],
      [
        'many matches in one sentence',
        'the Secretary shall designate '.repeat(8000),
      ],
      ['many determinations', 'if the clerk determines '.repeat(8000)],
      [
        'long punctuation runs',
        'The Secretary may waive' + ',.;'.repeat(100000) + 'x',
      ],
      ['blank-line runs', ('\n' + ' '.repeat(20)).repeat(20000) + 'x'],
      [
        'unclosed parentheses',
        '('.repeat(100000) + 'the Secretary shall adopt rules',
      ],
      ['repeated effective dates', 'takes effect on January 1 '.repeat(60000)],
      ['phrases without stops', 'pursuant to the '.repeat(20000)],
    ])('%s', (_n, text) => {
      expect(timed(text)).toBeLessThan(bound);
    });
  });
});

function report(label: string, sections: Section[], refs: ExternalRef[]): void {
  const result = extractDelegations(sections, refs);
  // Printed for a human hand check; deliberately no count assertions.
  console.info(`\n=== ${label} ===\n${JSON.stringify(result, null, 1)}`);
  expect(result.decidedLater.length).toBeLessThanOrEqual(GROUP_CAP);
  for (const item of [
    ...result.decidedLater,
    ...result.dependsOn,
    ...result.takesEffect,
  ])
    expect(item.quote.length).toBeLessThanOrEqual(200);
}

describeWithFixture('us-s202-119-is', () => {
  it('runs over the real bill', () => {
    const raw = parseXml(readFileSync(fixturePath('us-s202-119-is')!), {
      sourceUrl: 'https://example.test/bill.xml',
      fetchedAt: '2026-10-13T12:00:00.000Z',
    });
    const { doc } = enrichDocument(raw, chunkDocument(raw));
    report('S. 202', doc.sections, doc.externalRefs);
  });
});

// The Columbus Issue 8 PDF is not in fixtures/manifest.json yet, so describeWithFixture would
// always skip it. Gate on the file itself until it is registered.
const issue8 = join(downloadsDirectory, 'oh-columbus-issue8-2026.pdf');
describe.skipIf(!existsSync(issue8))(
  'oh-columbus-issue8-2026 (unregistered)',
  () => {
    it('runs over the real measure', async () => {
      const raw = await parsePdf(readFileSync(issue8), {
        sourceUrl: 'https://example.test/issue8.pdf',
        fetchedAt: '2026-10-13T12:00:00.000Z',
      });
      const { doc } = enrichDocument(raw, chunkDocument(raw));
      report('Issue 8', doc.sections, doc.externalRefs);
    });
  },
);

describe('afterLastConjunction', () => {
  it.each([
    [
      'The Secretary shall act after the Director approves',
      'the Director approves',
    ],
    [
      'x, if the Board asks, when the Secretary determines',
      'the Secretary determines',
    ],
    ['no conjunction here', 'no conjunction here'],
    ['if a; the Secretary', 'if a; the Secretary'],
    // The original regex's `.*` stopped at a line break: only a first-line conjunction counted.
    ['when a\nif b', 'a\nif b'],
    ['a\nif b', 'a\nif b'],
  ])('%j -> %j', (input, expected) => {
    expect(afterLastConjunction(input)).toBe(expected);
  });
  it('is linear on a long run with no comma or semicolon', () => {
    const started = performance.now();
    afterLastConjunction('if '.repeat(60_000));
    expect(performance.now() - started).toBeLessThan(100);
  });
});
