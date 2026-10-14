import { describe, expect, test } from 'vitest';
import type {
  AnswerResult,
  NormalizedDoc,
  Section,
} from '../core/model/index.js';
import { checkScenarioSubject } from '../core/scenario/subject.js';
import { defaultScenarioSubject, NEUTRAL_SUBJECT } from './default-scenario.js';

const section = (
  id: string,
  text: string,
  children: Section[] = [],
): Section => ({
  id,
  level: 1,
  heading: id,
  spans: [{ text, status: 'unchanged' }],
  children,
});

const docOf = (
  sections: Section[],
  title: string | null = null,
): NormalizedDoc => ({
  docId: 'd'.repeat(64),
  sourceUrl: 'https://example.gov/x',
  format: 'text',
  fetchedAt: '2026-10-14T00:00:00.000Z',
  metadata: {
    title,
    billNumber: null,
    jurisdiction: null,
    session: null,
    version: null,
    sponsors: null,
    source: 'extracted',
  },
  sections,
  definitions: [],
  externalRefs: [],
  warnings: [],
});

const summaryCiting = (
  ...cites: { id: string; valid?: boolean }[]
): AnswerResult =>
  ({
    text: 'x',
    citations: cites.map((c) => ({
      sectionId: c.id,
      valid: c.valid ?? true,
      chunkIds: [],
    })),
    declined: false,
    warnings: [],
  }) as unknown as AnswerResult;

const omnibus = docOf(
  [
    section('a', 'Tuition at public schools rises.'),
    section('b', 'Landlords and tenants must sign a lease.'),
    section('c', 'Drivers need a new license.'),
  ],
  'Omnibus act',
);

describe('defaultScenarioSubject', () => {
  test('uses the group the most-cited section affects', () => {
    const summary = summaryCiting({ id: 'b' }, { id: 'c' }, { id: 'b' });
    expect(defaultScenarioSubject(omnibus, summary)).toBe('a renter');
  });

  test('a tie goes to the earliest citation; invalid citations do not count', () => {
    expect(
      defaultScenarioSubject(omnibus, summaryCiting({ id: 'c' }, { id: 'b' })),
    ).toBe('a driver');
    expect(
      defaultScenarioSubject(
        omnibus,
        summaryCiting({ id: 'a', valid: false }, { id: 'b' }),
      ),
    ).toBe('a renter');
  });

  test('finds a cited section nested in a division', () => {
    const doc = docOf([
      section('div', 'Divisions.', [section('div/s', 'Students pay tuition.')]),
    ]);
    expect(defaultScenarioSubject(doc, summaryCiting({ id: 'div/s' }))).toBe(
      'a student',
    );
  });

  test('the cited section alone decides, not the bill title', () => {
    const doc = docOf([section('a', 'Drivers need a license.')], 'Tenant act');
    expect(defaultScenarioSubject(doc, summaryCiting({ id: 'a' }))).toBe(
      'a driver',
    );
  });

  test('falls back to the bill-wide group without a summary, citations, or a match', () => {
    expect(defaultScenarioSubject(omnibus)).toBe('a renter');
    expect(defaultScenarioSubject(omnibus, summaryCiting())).toBe('a renter');
    expect(defaultScenarioSubject(omnibus, summaryCiting({ id: 'gone' }))).toBe(
      'a renter',
    );
    const neutralCited = docOf([
      section('n', 'The office opens.'),
      section('t', 'Tenants pay rent.'),
    ]);
    expect(
      defaultScenarioSubject(neutralCited, summaryCiting({ id: 'n' })),
    ).toBe('a renter');
  });

  test('a bill that names no group gets a neutral resident, and it is deterministic', () => {
    const plain = docOf([section('a', 'The office opens on Monday.')]);
    expect(defaultScenarioSubject(plain)).toBe(NEUTRAL_SUBJECT);
    expect(defaultScenarioSubject(plain)).toBe(NEUTRAL_SUBJECT);
  });

  test('every possible subject passes the reader-subject checks', () => {
    expect(checkScenarioSubject(NEUTRAL_SUBJECT).ok).toBe(true);
    expect(checkScenarioSubject(defaultScenarioSubject(omnibus)).ok).toBe(true);
  });
});
