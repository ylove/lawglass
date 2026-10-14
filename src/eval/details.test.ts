import { expect, test } from 'vitest';
import { type GoldenQuestion, ZERO_USAGE } from '../core/model/index.js';
import { mean, recallAtK } from './metrics.js';
import { scoreRetrieval } from './run.js';
import {
  firstRelevantRank,
  retrievalDetails,
  QuestionDetail,
  type RetrievalDetailHit,
} from './details.js';

const hit = (sectionId: string): RetrievalDetailHit => ({
  sectionId,
  breadcrumb: `Section ${sectionId}`,
  score: 0.25,
});
const question: GoldenQuestion = {
  id: 'q',
  kind: 'exact',
  question: 'Which rules apply?',
  expectedSectionIds: ['sec-3/b', 'sec-4/a'],
};

test('details preserve fractional recall, merged siblings and ancestor/descendant relevance', () => {
  const hits = [
    { ...hit('sec-3/a'), coveredSectionIds: ['sec-3/a', 'sec-3/b'] },
    ...Array.from({ length: 4 }, () => hit('sec-10')),
    hit('sec-4'),
  ];
  const retrievals = new Map([
    ['q', { hits, usage: ZERO_USAGE, latencyMs: 1 }],
  ]);
  const details = retrievalDetails([question], retrievals);
  expect(details[0]).toEqual({
    ...question,
    firstRelevantRank: 1,
    top10: hits,
  });
  const metrics = scoreRetrieval([question], retrievals);
  expect(metrics.recallAt5).toBe(0.5);
  expect(
    mean(details.map((q) => recallAtK(q.top10, q.expectedSectionIds, 5))),
  ).toBe(metrics.recallAt5);
  expect(
    firstRelevantRank([hit('sec-4/a/1')], question.expectedSectionIds),
  ).toBe(1);
  expect(
    firstRelevantRank([hit('sec-30')], question.expectedSectionIds),
  ).toBeNull();
});

test('keeps ranks 5 and 10, caps hits at ten, and records empty results', () => {
  for (const rank of [5, 10, 11]) {
    const hits = [
      ...Array.from({ length: rank - 1 }, () => hit('sec-9')),
      hit('sec-3/b'),
    ];
    const [detail] = retrievalDetails([question], new Map([['q', { hits }]]));
    expect(detail?.top10).toHaveLength(Math.min(rank, 10));
    expect(detail?.firstRelevantRank).toBe(rank <= 10 ? rank : null);
  }
  expect(
    retrievalDetails([question], new Map([['q', { hits: [] }]]))[0],
  ).toMatchObject({ firstRelevantRank: null, top10: [] });
});

test('skips unanswerable and missing retrievals, retaining golden order', () => {
  const unanswerable: GoldenQuestion = {
    id: 'u',
    kind: 'unanswerable',
    question: 'Unknown?',
    expectedSectionIds: [],
  };
  const second = { ...question, id: 'a' };
  const missing = { ...question, id: 'missing' };
  const retrievals = new Map([
    ['a', { hits: [] }],
    ['q', { hits: [] }],
    ['u', { hits: [] }],
  ]);
  expect(
    retrievalDetails([question, unanswerable, missing, second], retrievals).map(
      (q) => q.id,
    ),
  ).toEqual(['q', 'a']);
});

test('run detail schema rejects invalid ranks, scores, and unanswerable questions', () => {
  const detail = {
    ...question,
    firstRelevantRank: null,
    top10: [hit('sec-9')],
  };
  expect(QuestionDetail.safeParse(detail).success).toBe(true);
  for (const firstRelevantRank of [0, 11, 1.5])
    expect(
      QuestionDetail.safeParse({ ...detail, firstRelevantRank }).success,
    ).toBe(false);
  expect(
    QuestionDetail.safeParse({
      ...detail,
      top10: [{ ...hit('sec-9'), score: Infinity }],
    }).success,
  ).toBe(false);
  expect(
    QuestionDetail.safeParse({
      ...detail,
      kind: 'unanswerable',
      expectedSectionIds: [],
    }).success,
  ).toBe(false);
});
