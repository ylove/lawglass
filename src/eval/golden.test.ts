import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeWithFixture,
  fixturePath,
} from '../../tests/support/fixtures.js';
import { GoldenSet, type Section } from '../core/model/index.js';
import { parseXml } from '../core/parse/index.js';

const goldenDirectory = new URL('./golden/', import.meta.url);

/** One golden set per eval fixture (spec §8). */
const FIXTURES = [
  'oh-hb62-135-in',
  'oh-sb113-136-in',
  'oh-sb203-133-in',
  'us-hr5009-118-enr',
  'us-s202-119-is',
] as const;

function readGolden(fixture: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`${fixture}.json`, goldenDirectory), 'utf8'),
  ) as unknown;
}

const sets = FIXTURES.map((fixture) => ({
  fixture,
  result: GoldenSet.safeParse(readGolden(fixture)),
}));

function parsed(fixture: string): GoldenSet {
  const entry = sets.find((s) => s.fixture === fixture);
  if (!entry?.result.success) throw new Error(`${fixture} is not a GoldenSet`);
  return entry.result.data;
}

describe('golden sets', () => {
  it('has exactly one JSON file per fixture', () => {
    const files = readdirSync(goldenDirectory)
      .filter((file) => file.endsWith('.json'))
      .sort();
    expect(files).toEqual(FIXTURES.map((fixture) => `${fixture}.json`));
  });

  describe.each(FIXTURES)('%s', (fixture) => {
    it('validates against the frozen GoldenSet schema', () => {
      const { result } = sets.find((s) => s.fixture === fixture)!;
      expect(result.error?.issues).toBeUndefined();
    });

    it('names its own fixture', () => {
      expect(parsed(fixture).fixture).toBe(fixture);
    });

    it('has 20 to 30 questions, exactly 3 of them unanswerable', () => {
      const { questions } = parsed(fixture);
      expect(questions.length).toBeGreaterThanOrEqual(20);
      expect(questions.length).toBeLessThanOrEqual(30);
      expect(questions.filter((q) => q.kind === 'unanswerable')).toHaveLength(
        3,
      );
    });

    it('lists each expected section once per question', () => {
      for (const q of parsed(fixture).questions)
        expect(new Set(q.expectedSectionIds).size, q.id).toBe(
          q.expectedSectionIds.length,
        );
    });
  });

  it('uses question ids that are unique across all sets', () => {
    const ids = FIXTURES.flatMap((fixture) =>
      parsed(fixture).questions.map((q) => q.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Frozen sets are never tuned to make a mode win (spec §10); a corrected set needs a new freeze.
  it('records one freeze commit for every set', () => {
    const frozen = new Set(
      FIXTURES.map((fixture) => parsed(fixture).frozenAtCommit),
    );
    expect([...frozen]).toEqual([expect.stringMatching(/^[0-9a-f]{40}$/)]);
  });

  // The schema is what keeps a hand-edited set honest; prove it rejects the likely mistakes.
  describe('the GoldenSet schema', () => {
    const base = {
      fixture: 'us-s202-119-is',
      frozenAtCommit: null,
      questions: [
        {
          id: 'x-01',
          question: 'When does it start?',
          kind: 'paraphrase',
          expectedSectionIds: ['sec-3/a'],
        },
      ],
    };
    const withQuestion = (patch: Record<string, unknown>) => ({
      ...base,
      questions: [{ ...base.questions[0], ...patch }],
    });

    it('accepts the baseline', () => {
      expect(GoldenSet.safeParse(base).success).toBe(true);
    });

    it('rejects an answerable question with no expected sections', () => {
      expect(
        GoldenSet.safeParse(withQuestion({ expectedSectionIds: [] })).success,
      ).toBe(false);
    });

    it('rejects an unanswerable question with expected sections', () => {
      expect(
        GoldenSet.safeParse(withQuestion({ kind: 'unanswerable' })).success,
      ).toBe(false);
    });

    it('rejects a section id that could not be cited', () => {
      expect(
        GoldenSet.safeParse(withQuestion({ expectedSectionIds: ['sec 3/a'] }))
          .success,
      ).toBe(false);
    });

    it('rejects an unknown question kind', () => {
      expect(
        GoldenSet.safeParse(withQuestion({ kind: 'trivia' })).success,
      ).toBe(false);
    });

    it('rejects an empty set', () => {
      expect(GoldenSet.safeParse({ ...base, questions: [] }).success).toBe(
        false,
      );
    });
  });
});

/** Every section id with its own (not its children's) text, struck spans included. */
function ownText(
  sections: readonly Section[],
  into = new Map<string, string>(),
) {
  for (const section of sections) {
    into.set(section.id, section.spans.map((span) => span.text).join(''));
    ownText(section.children, into);
  }
  return into;
}

// Local-only ground-truth check: expected ids must be real parser output with text of their
// own. The PDF sets get the same check once parsePdf is on main (#68).
for (const fixture of ['us-s202-119-is', 'us-hr5009-118-enr'] as const) {
  describeWithFixture(fixture, () => {
    it('expects only sections the XML parser produces, each with its own text', () => {
      const doc = parseXml(readFileSync(fixturePath(fixture)!), {
        sourceUrl: 'https://www.govinfo.gov/',
        fetchedAt: '2026-10-13T00:00:00.000Z',
      });
      const text = ownText(doc.sections);
      for (const q of parsed(fixture).questions)
        for (const id of q.expectedSectionIds)
          expect(text.get(id) ?? '', `${q.id} -> ${id}`).toMatch(/\S/);
    });
  });
}
