import { describe, expect, test } from 'vitest';
import {
  citationValidity,
  declineRate,
  deletedLeakageRate,
  findLeakedSpans,
  inventedAnswerRate,
  isEvalDecline,
  hitSectionIds,
  mean,
  p50,
  percentile,
  recallAtK,
  reciprocalRank,
  removalAcknowledgedRate,
  sectionsMatch,
  summarizeGrades,
  type AnswerOutcome,
} from './metrics.js';

const hit = (sectionId: string, coveredSectionIds?: string[]) => ({
  sectionId,
  coveredSectionIds,
});

function outcome(partial: Partial<AnswerOutcome>): AnswerOutcome {
  return {
    kind: 'exact',
    text: '',
    declined: false,
    validCitations: 0,
    invalidCitations: 0,
    readingGrade: null,
    ...partial,
  };
}

describe('sectionsMatch', () => {
  test('matches equal ids and ancestors or descendants on whole segments', () => {
    expect(sectionsMatch('sec-4', 'sec-4')).toBe(true);
    expect(sectionsMatch('sec-4/b', 'sec-4/b/2')).toBe(true);
    expect(sectionsMatch('sec-4/b/2/A', 'sec-4/b/2')).toBe(true);
  });

  test('does not match siblings or id prefixes that are not path ancestors', () => {
    expect(sectionsMatch('sec-1', 'sec-10')).toBe(false);
    expect(sectionsMatch('sec-10', 'sec-1')).toBe(false);
    expect(sectionsMatch('sec-4/a', 'sec-4/b')).toBe(false);
  });
});

describe('hitSectionIds', () => {
  test('prefers coveredSectionIds and falls back to the chunk section', () => {
    expect(hitSectionIds(hit('sec-2', ['sec-2', 'sec-3']))).toEqual([
      'sec-2',
      'sec-3',
    ]);
    expect(hitSectionIds(hit('sec-2'))).toEqual(['sec-2']);
  });
});

describe('recallAtK', () => {
  const ranked = [hit('sec-9'), hit('sec-2'), hit('sec-7'), hit('sec-1')];

  test('is the share of expected sections inside the top k', () => {
    expect(recallAtK(ranked, ['sec-2', 'sec-1'], 2)).toBe(0.5);
    expect(recallAtK(ranked, ['sec-2', 'sec-1'], 4)).toBe(1);
  });

  test('is 0 when nothing matches or nothing is expected', () => {
    expect(recallAtK(ranked, ['sec-5'], 4)).toBe(0);
    expect(recallAtK(ranked, [], 4)).toBe(0);
    expect(recallAtK([], ['sec-1'], 5)).toBe(0);
  });

  test('credits a merged chunk for every section it covers', () => {
    const merged = [hit('sec-3', ['sec-3', 'sec-4'])];
    expect(recallAtK(merged, ['sec-4'], 1)).toBe(1);
  });

  test('credits ancestor and descendant chunks', () => {
    expect(recallAtK([hit('sec-4')], ['sec-4/b'], 1)).toBe(1);
    expect(recallAtK([hit('sec-4/b/2')], ['sec-4/b'], 1)).toBe(1);
  });
});

describe('reciprocalRank', () => {
  test('is 1 over the rank of the first matching hit', () => {
    const ranked = [hit('sec-9'), hit('sec-2'), hit('sec-1')];
    expect(reciprocalRank(ranked, ['sec-2'])).toBe(0.5);
    expect(reciprocalRank(ranked, ['sec-1', 'sec-2'])).toBe(0.5);
    expect(reciprocalRank(ranked, ['sec-9'])).toBe(1);
  });

  test('is 0 when nothing matches', () => {
    expect(reciprocalRank([hit('sec-9')], ['sec-2'])).toBe(0);
    expect(reciprocalRank([], ['sec-2'])).toBe(0);
  });
});

describe('mean, percentile and p50', () => {
  test('mean of nothing is 0, not NaN', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 6])).toBe(3);
  });

  test('p50 is the middle value, or the average of the middle two', () => {
    expect(p50([9, 1, 5])).toBe(5);
    expect(p50([4, 1, 3, 2])).toBe(2.5);
    expect(p50([7])).toBe(7);
    expect(p50([])).toBe(0);
  });

  test('interpolates other percentiles and clamps out-of-range ones', () => {
    expect(percentile([10, 20, 30, 40, 50], 25)).toBe(20);
    expect(percentile([10, 20], 90)).toBeCloseTo(19);
    expect(percentile([10, 20], 150)).toBe(20);
    expect(percentile([10, 20], -5)).toBe(10);
  });

  test('does not reorder its input', () => {
    const values = [3, 1, 2];
    p50(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('citationValidity', () => {
  test('is valid citations over all citations written', () => {
    expect(
      citationValidity([
        outcome({ validCitations: 3, invalidCitations: 1 }),
        outcome({ validCitations: 4, invalidCitations: 0 }),
      ]),
    ).toBe(7 / 8);
  });

  test('is 0 when no citation was written', () => {
    expect(citationValidity([outcome({})])).toBe(0);
    expect(citationValidity([])).toBe(0);
  });
});

describe('declineRate', () => {
  test('counts only unanswerable questions', () => {
    expect(
      declineRate([
        outcome({ kind: 'unanswerable', declined: true }),
        outcome({ kind: 'unanswerable', declined: false }),
        outcome({ kind: 'exact', declined: true }),
      ]),
    ).toBe(0.5);
  });

  test('is 0 with no unanswerable questions', () => {
    expect(declineRate([outcome({ kind: 'exact' })])).toBe(0);
  });
});

describe('eval declines', () => {
  test.each([
    "The excerpts don't show any tax cuts. They describe a pilot program. [S:sec-3/a]",
    'The bill does not say who pays the local tax. It sets up a pilot program. [S:sec-3/a]',
    'This document does not address tax cuts. [S:sec-3/a]',
    'The provided excerpts do not specify a tax rate. [S:sec-3/a]',
    "I couldn't find any tax cuts in the document. It describes a pilot program. [S:sec-3/a]",
    'I couldn’t find that information in the bill.',
    "This document doesn't address that question. It sets up a pilot program. [S:sec-3/a]",
  ])('counts a realistic soft decline: %s', (text) => {
    const answer = outcome({ kind: 'unanswerable', text });
    expect(isEvalDecline(answer)).toBe(true);
    expect(declineRate([answer])).toBe(1);
    expect(inventedAnswerRate([answer])).toBe(0);
  });

  test.each([
    'The bill provides tax cuts of ten percent. [S:sec-3/a]',
    'The bill does not require employers to pay tax. [S:sec-3/a]',
    'I found a tax exemption. [S:sec-3/a]',
    "The program offers grants. The excerpts don't cover the tax deadline. [S:sec-3/a]",
  ])(
    'keeps substantive answers distinct from a no-answer lead-in: %s',
    (text) => {
      expect(isEvalDecline(outcome({ text }))).toBe(false);
    },
  );

  test('reports the unanswerable non-declines separately and leaves an absent denominator undefined', () => {
    expect(inventedAnswerRate([])).toBeUndefined();
    expect(inventedAnswerRate([outcome({ kind: 'exact' })])).toBeUndefined();
    const outcomes = [
      outcome({ kind: 'unanswerable', declined: true }),
      outcome({ kind: 'unanswerable', text: "I couldn't find it." }),
      outcome({ kind: 'unanswerable', text: 'The rate is ten percent.' }),
      outcome({ kind: 'exact', text: 'The rate is ten percent.' }),
    ];
    expect(declineRate(outcomes)).toBe(2 / 3);
    expect(inventedAnswerRate(outcomes)).toBe(1 / 3);
  });
});

describe('deleted-text leakage', () => {
  const struck = [
    'The harvest permit fee is twenty dollars for each steward.',
    'five dollars',
  ] as const;

  test('finds a struck span of four or more words, ignoring case and punctuation', () => {
    expect(
      findLeakedSpans(
        'Per the bill, THE HARVEST PERMIT FEE IS TWENTY DOLLARS for each steward!',
        struck,
      ),
    ).toEqual([struck[0]]);
  });

  test('detects a distinctive partial quotation of the synthetic deleted fee', () => {
    const deleted =
      'The harvest permit fee is twenty dollars for each orchard steward per season.';
    expect(
      findLeakedSpans('The harvest permit fee is twenty dollars.', [deleted]),
    ).toEqual([deleted]);
    expect(
      findLeakedSpans('It is twenty dollars for each orchard steward.', [
        deleted,
      ]),
    ).toEqual([deleted]);
  });

  test('line wrapping cannot hide a copied partial quotation', () => {
    expect(
      findLeakedSpans('The harvest permit fee is\n twenty dollars.', struck),
    ).toEqual([struck[0]]);
  });

  test('removal context stays with a quoted sentence containing a clause boundary', () => {
    const deleted = 'Stewards may prune but must harvest every tree.';
    expect(
      findLeakedSpans(`The bill removes the sentence: “${deleted}”`, [deleted]),
    ).toEqual([]);
    expect(
      findLeakedSpans(`The bill removes the sentence: "${deleted}"`, [deleted]),
    ).toEqual([]);
  });

  test('does not mistake wording shared with the replacement for deleted text', () => {
    const deleted =
      'The harvest permit fee is twenty dollars for each orchard steward per season.';
    const current =
      'The harvest permit fee is twelve dollars for each orchard steward per season.';
    expect(findLeakedSpans(current, [deleted], [current])).toEqual([]);
    expect(
      findLeakedSpans(
        'The harvest permit fee is twenty dollars.',
        [deleted],
        [current],
      ),
    ).toEqual([deleted]);
  });

  test.each(['exact', 'removed'] as const)(
    'acknowledged removal is safe for a %s question',
    (kind) => {
      expect(
        deletedLeakageRate(
          [
            outcome({
              kind,
              text: `The bill removes the sentence: “${struck[0]}”`,
            }),
          ],
          struck,
        ),
      ).toBe(0);
      expect(
        deletedLeakageRate(
          [outcome({ kind, text: `“${struck[0]}” was struck by the bill.` })],
          struck,
        ),
      ).toBe(0);
    },
  );

  test.each([
    'The fee used to be twenty dollars for each steward.',
    'Previously, the harvest permit fee is twenty dollars for each steward.',
    'The bill replaces “The harvest permit fee is twenty dollars for each steward.”',
    'The harvest permit fee is twenty dollars for each steward. That rule is removed by the bill.',
    'The harvest permit fee is twenty dollars for each steward. The bill no longer includes this sentence.',
  ])(
    'recognizes paraphrased and following-sentence acknowledgements: %s',
    (text) => {
      expect(findLeakedSpans(text, struck)).toEqual([]);
    },
  );

  test.each([
    'The bill removes the cap, so each orchard steward shall pay twenty dollars per season.',
    'Each orchard steward shall pay twenty dollars per season. The bill removes the cap.',
    'Each orchard steward shall pay twenty dollars per season. That rule is not removed.',
    'Each orchard steward shall pay twenty dollars per season.\n\nThat rule is removed.',
  ])('unrelated or negated cues cannot mask a leak: %s', (text) => {
    const deleted = 'Each orchard steward shall pay twenty dollars per season.';
    expect(findLeakedSpans(text, [deleted])).toEqual([deleted]);
  });

  test('live words in a different order do not make a distinctive deleted n-gram', () => {
    expect(
      findLeakedSpans(
        'If the accused used force in self-defense, the prosecution must prove it.',
        ['The person used force in self-defense.'],
        [
          'The accused used the force in self-defense.',
          'A person using force in self-defense.',
        ],
      ),
    ).toEqual([]);
  });

  test('checks distinctive n-grams within a longer quotation shared partly with live law', () => {
    const deleted =
      'The harvest permit fee is twenty dollars for each orchard steward per season.';
    const live =
      'The harvest permit fee is twelve dollars for each orchard steward per season.';
    expect(findLeakedSpans(deleted, [deleted], [live])).toEqual([deleted]);
    expect(
      findLeakedSpans(
        'For each orchard steward per season, the harvest permit fee is payable.',
        [deleted],
        [live],
      ),
    ).toEqual([]);
  });

  test('a removed answer asserting the deleted fee as current law leaks', () => {
    expect(
      deletedLeakageRate(
        [outcome({ kind: 'removed', text: struck[0] })],
        struck,
      ),
    ).toBe(1);
  });

  test.each(['. ', '; ', ', but ', ', and ', '\n\n'])(
    'an unrelated removal claim does not excuse leakage across %j',
    (separator) => {
      expect(
        deletedLeakageRate(
          [
            outcome({
              text: `The bill removes the notice rule${separator}${struck[0]}`,
            }),
          ],
          struck,
        ),
      ).toBe(1);
    },
  );

  test('scores repeated quotations individually, including an assertion after a removal quote', () => {
    expect(
      deletedLeakageRate(
        [
          outcome({
            text: `The bill removes the sentence: ${struck[0]} Currently, ${struck[0]}`,
          }),
        ],
        struck,
      ),
    ).toBe(1);
  });

  test('negated removal and removal words inside the deleted claim do not excuse it', () => {
    expect(
      deletedLeakageRate(
        [
          outcome({
            text: `The bill does not remove the sentence: ${struck[0]}`,
          }),
        ],
        struck,
      ),
    ).toBe(1);
    expect(
      findLeakedSpans('Stewards may remove all trees.', [
        'Stewards may remove all trees.',
      ]),
    ).toEqual(['Stewards may remove all trees.']);
  });

  test('ignores short struck spans that would collide with live text', () => {
    expect(findLeakedSpans('It costs five dollars.', struck)).toEqual([]);
  });

  test('matches whole words only', () => {
    expect(
      findLeakedSpans('a permit costs twenties', ['a permit costs twenty']),
    ).toEqual([]);
  });

  test('rate includes every question kind and judges the answer text', () => {
    const leaked = struck[0];
    const rate = deletedLeakageRate(
      [
        outcome({ kind: 'exact', text: `It says ${leaked}` }),
        outcome({ kind: 'paraphrase', text: 'The fee is twelve dollars.' }),
        outcome({ kind: 'removed', text: leaked }),
      ],
      struck,
    );
    expect(rate).toBe(2 / 3);
  });

  test('is 0 when there is nothing to score', () => {
    expect(deletedLeakageRate([], struck)).toBe(0);
    expect(deletedLeakageRate([outcome({ kind: 'removed' })], struck)).toBe(0);
  });
});

describe('removalAcknowledgedRate', () => {
  test('counts removed answers that talk about removal; a decline does not count', () => {
    expect(
      removalAcknowledgedRate([
        outcome({ kind: 'removed', text: 'The bill strikes the old rule.' }),
        outcome({ kind: 'removed', text: 'Neighbors get notice.' }),
        outcome({ kind: 'removed', text: 'Removed text.', declined: true }),
        outcome({ kind: 'exact', text: 'removed' }),
      ]),
    ).toBe(1 / 3);
  });

  test('is 0 with no removed questions', () => {
    expect(removalAcknowledgedRate([outcome({})])).toBeUndefined();
  });
});

describe('summarizeGrades', () => {
  test('averages gradable answers and counts those above grade 9', () => {
    expect(summarizeGrades([6, 10, null, 12])).toEqual({
      mean: 28 / 3,
      above9: 2,
    });
  });

  test('grade exactly 9 is within target; no grades gives a null mean', () => {
    expect(summarizeGrades([9])).toEqual({ mean: 9, above9: 0 });
    expect(summarizeGrades([null])).toEqual({ mean: null, above9: 0 });
    expect(summarizeGrades([])).toEqual({ mean: null, above9: 0 });
  });
});
