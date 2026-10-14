import { describe, expect, it } from 'vitest';
import {
  AnswerResult,
  AskEvent,
  BillHistory,
  BillMetadata,
  ChipId,
  DocDetail,
  Scenario,
  ScenarioFigure,
  SponsorLink,
  SponsorProfile,
  SummaryResponse,
} from './index.js';

const link = {
  kind: 'official',
  url: 'https://www.congress.gov/member/x',
  label: 'Congress.gov',
  verified: true,
};

const frame = (kind: 'setup' | 'rule' | 'effect') => ({
  kind,
  avatar: 'worker',
  icon: 'job',
  caption: 'A short caption.',
  citations: ['sec-1'],
});
const scenario = (n = 3) => ({
  subject: 'Overtime pay',
  profile: {
    name: 'Sam',
    label: 'A warehouse worker',
    assumptions: [
      { key: 'wage', label: 'Hourly wage', value: 20, unit: 'USD' },
    ],
    illustrative: true,
  },
  frames: ['setup', 'rule', 'effect', 'effect']
    .slice(0, n)
    .map((k) => frame(k as 'setup')),
});

describe('SponsorLink / SponsorProfile', () => {
  it('accepts an https link and rejects http or malformed urls', () => {
    expect(SponsorLink.safeParse(link).success).toBe(true);
    expect(
      SponsorLink.safeParse({ ...link, url: 'http://example.com' }).success,
    ).toBe(false);
    expect(SponsorLink.safeParse({ ...link, url: 'nope' }).success).toBe(false);
    expect(
      SponsorLink.safeParse({ ...link, url: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });

  it('never lets a search link be verified', () => {
    const search = { ...link, kind: 'search' };
    expect(SponsorLink.safeParse({ ...search, verified: false }).success).toBe(
      true,
    );
    expect(SponsorLink.safeParse({ ...search, verified: true }).success).toBe(
      false,
    );
  });

  it('parses a full profile and a minimal one', () => {
    expect(
      SponsorProfile.safeParse({
        name: 'Jane Doe',
        role: 'sponsor',
        party: 'D',
        state: 'OH',
        district: '3',
        chamber: 'house',
        bioguideId: 'D000001',
        memberId: '42',
        links: [link],
      }).success,
    ).toBe(true);
    expect(
      SponsorProfile.safeParse({ name: 'J', role: 'cosponsor', links: [] })
        .success,
    ).toBe(true);
    expect(
      SponsorProfile.safeParse({ name: 'J', role: 'author', links: [] })
        .success,
    ).toBe(false);
  });
});

describe('BillHistory', () => {
  it('parses a full history and an empty one', () => {
    expect(
      BillHistory.safeParse({
        officialSummary: {
          text: 'Summary.',
          source: 'Congressional Research Service',
          url: 'https://www.congress.gov/bill/x',
          date: '2025-03-01',
        },
        versions: [{ code: 'ih', label: 'Introduced in House' }],
        actions: [
          { date: '2025-01-03', text: 'Introduced.', chamber: 'House' },
        ],
        amendments: [
          {
            id: 'a1',
            status: 'adopted',
            sponsor: { name: 'Jane Doe', bioguideId: 'D000001' },
          },
        ],
        sources: [
          {
            host: 'www.congress.gov',
            url: 'https://www.congress.gov/x',
            fetchedAt: '2026-10-14T00:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      BillHistory.safeParse({
        versions: [],
        actions: [],
        amendments: [],
        sources: [],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown amendment status', () => {
    expect(
      BillHistory.safeParse({
        versions: [],
        actions: [],
        amendments: [{ id: 'a', status: 'passed' }],
        sources: [],
      }).success,
    ).toBe(false);
  });
});

describe('BillHistory urls are https-only', () => {
  const http = 'http://example.com/x';
  const https = 'https://example.com/x';
  const base = { versions: [], actions: [], amendments: [], sources: [] };
  const cases: [string, object][] = [
    [
      'officialSummary',
      { officialSummary: { text: 't', source: 's', url: http } },
    ],
    ['versions', { versions: [{ code: 'c', label: 'l', url: http }] }],
    ['actions', { actions: [{ date: 'd', text: 't', url: http }] }],
    ['amendments', { amendments: [{ id: 'a', status: 'unknown', url: http }] }],
    [
      'sources',
      {
        sources: [
          { host: 'h', url: http, fetchedAt: '2026-10-14T00:00:00.000Z' },
        ],
      },
    ],
  ];
  it.each(cases)('rejects an http url in %s', (_name, patch) => {
    expect(BillHistory.safeParse({ ...base, ...patch }).success).toBe(false);
    const fixed = JSON.parse(
      JSON.stringify(patch).replace(http, https),
    ) as object;
    expect(BillHistory.safeParse({ ...base, ...fixed }).success).toBe(true);
  });
});

describe('Scenario', () => {
  it('parses 3 and 4 frames and rejects 2 or 5', () => {
    expect(Scenario.safeParse(scenario(3)).success).toBe(true);
    expect(Scenario.safeParse(scenario(4)).success).toBe(true);
    expect(Scenario.safeParse(scenario(2)).success).toBe(false);
    const five = scenario(4);
    five.frames.push(frame('effect'));
    expect(Scenario.safeParse(five).success).toBe(false);
  });

  it('requires illustrative: true', () => {
    const s = scenario();
    expect(
      Scenario.safeParse({
        ...s,
        profile: { ...s.profile, illustrative: false },
      }).success,
    ).toBe(false);
    const { illustrative: _omit, ...rest } = s.profile;
    expect(Scenario.safeParse({ ...s, profile: rest }).success).toBe(false);
  });

  it('only allows closed avatar and icon ids, and bounded captions', () => {
    const s = scenario();
    const bad = (patch: object) =>
      Scenario.safeParse({
        ...s,
        frames: [{ ...s.frames[0], ...patch }, s.frames[1], s.frames[2]],
      }).success;
    expect(bad({ icon: '<svg onload=x>' })).toBe(false);
    expect(bad({ avatar: 'celebrity' })).toBe(false);
    expect(bad({ caption: 'x'.repeat(201) })).toBe(false);
    expect(bad({ caption: 'x'.repeat(200) })).toBe(true);
  });

  it('requires expr for computed figures', () => {
    const f = { value: 2000, unit: 'USD' };
    expect(ScenarioFigure.safeParse({ ...f, source: 'bill' }).success).toBe(
      true,
    );
    expect(ScenarioFigure.safeParse({ ...f, source: 'computed' }).success).toBe(
      false,
    );
    expect(
      ScenarioFigure.safeParse({
        ...f,
        source: 'computed',
        expr: '50000 * 0.04',
      }).success,
    ).toBe(true);
  });
});

describe('api additions', () => {
  it('ChipId includes history', () => {
    expect(ChipId.options).toContain('history');
  });

  it('AskEvent accepts a scenario event', () => {
    expect(
      AskEvent.safeParse({ type: 'scenario', scenario: scenario() }).success,
    ).toBe(true);
    expect(
      AskEvent.safeParse({ type: 'scenario', scenario: scenario(2) }).success,
    ).toBe(false);
  });

  it('SummaryResponse parses each status', () => {
    for (const status of ['cached', 'pending', 'disabled'])
      expect(SummaryResponse.safeParse({ status }).success).toBe(true);
    expect(SummaryResponse.safeParse({ status: 'other' }).success).toBe(false);
  });
});

// RC-era JSON, exactly as written to disk before these additions.
describe('backward compatibility with RC-era data', () => {
  const metadata = {
    title: 'Clean Water Act',
    billNumber: 'H.R. 1',
    jurisdiction: 'United States',
    session: null,
    version: null,
    sponsors: ['Mr. Smith'],
    source: 'structured',
  };

  it('BillMetadata without sponsorProfiles still parses', () => {
    expect(BillMetadata.safeParse(metadata).success).toBe(true);
  });

  it('DocDetail without history or preview still parses', () => {
    const iso = '2026-10-13T00:00:00.000Z';
    expect(
      DocDetail.safeParse({
        doc: {
          docId: 'a'.repeat(64),
          label: 'x',
          sourceUrl: 'https://example.com/x',
          format: 'pdf',
          title: null,
          billNumber: null,
          ingestedAt: iso,
          lastUsedAt: iso,
          backend: 'local',
        },
        metadata,
        outline: [{ id: 'sec-1', level: 1 }],
        externalRefs: [],
        warnings: [],
        hasLineNumbers: true,
      }).success,
    ).toBe(true);
  });

  it('AnswerResult without scenario still parses', () => {
    expect(
      AnswerResult.safeParse({
        text: 'x',
        citations: [],
        invalidCitations: [],
        warnings: [],
        declined: false,
        readingGrade: 8,
        provider: 'p',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
      }).success,
    ).toBe(true);
  });
});
