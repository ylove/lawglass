import { describe, expect, it, vi } from 'vitest';
import {
  buildHistoryText,
  cleanRecordText,
  MAX_FIELD_CHARS,
  MAX_HISTORY_ITEMS,
  NO_HISTORY_TEXT,
  runHistoryChip,
  STRIKE_INSERT_SENTENCE,
} from './chip-history.js';
import { getChip } from './chips.js';
import type { BillHistory, Section } from './model/index.js';

const section = (status: 'unchanged' | 'inserted' | 'deleted'): Section[] => [
  {
    id: 's1',
    kind: 'section',
    heading: 'Sec. 1',
    spans: [{ text: 'text', status }],
    children: [],
  } as unknown as Section,
];

const URL1 = 'https://www.congress.gov/bill/119th-congress/house-bill/1';

/** Shaped like a GovInfo BILLSTATUS import. */
const federal: BillHistory = {
  versions: [
    { code: 'rh', label: 'Reported in House', date: '2026-03-01', url: URL1 },
    { code: 'ih', label: 'Introduced in House', date: '2026-02-01' },
  ],
  actions: [
    {
      date: '2026-03-01',
      text: 'Reported by the Committee on Finance.',
      chamber: 'House',
      committee: 'Committee on Finance',
      url: URL1,
    },
    { date: '2026-02-01', text: 'Introduced in House.', chamber: 'House' },
  ],
  amendments: [
    {
      id: 'a1',
      number: 'H.AMDT.1',
      status: 'adopted',
      sponsor: { name: 'Rep. Rivera' },
      purpose: 'Removes the $50,000 limit.',
      date: '2026-03-01',
      url: URL1,
    },
  ],
  sources: [
    {
      host: 'api.govinfo.gov',
      url: 'https://api.govinfo.gov/x',
      fetchedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

/** Shaped like an Ohio LIS import: committee amendments, no sponsor, unknown status. */
const ohio: BillHistory = {
  versions: [
    {
      code: 'as-reported',
      label: 'As Reported by the House Finance Committee',
    },
  ],
  actions: [
    { date: '2026-04-02', text: 'Reported out.', committee: 'House Finance' },
  ],
  amendments: [
    {
      id: 'o1',
      status: 'unknown',
      committee: 'House Finance',
      description: 'Technical fixes.',
    },
  ],
  sources: [],
};

describe('buildHistoryText', () => {
  it('describes a federal-shaped history in date order, with record URLs', () => {
    const text = buildHistoryText(federal, section('unchanged'));
    expect(text).toContain('Versions of the bill:');
    expect(text).toContain(
      `- Reported in House, 2026-03-01. (Record: ${URL1})`,
    );
    expect(text.indexOf('2026-02-01: Introduced')).toBeLessThan(
      text.indexOf('2026-03-01: Reported'),
    );
    expect(text).toContain('(House, Committee on Finance)');
    expect(text).toContain(
      `An amendment offered by Rep. Rivera (H.AMDT.1) was adopted on 2026-03-01: Removes the $50,000 limit. (Record: ${URL1})`,
    );
    expect(text).toContain('Source: api.govinfo.gov.');
    expect(text).not.toContain(STRIKE_INSERT_SENTENCE);
  });

  it('describes an Ohio-shaped history without naming anyone the record does not', () => {
    const text = buildHistoryText(ohio, section('unchanged'));
    expect(text).toContain('As Reported by the House Finance Committee');
    expect(text).toContain(
      'An amendment considered in House Finance has a status not stated: Technical fixes.',
    );
    expect(text).not.toMatch(/offered by/);
  });

  it('names no one when the record has no sponsor or committee', () => {
    const text = buildHistoryText(
      { ...ohio, amendments: [{ id: 'x', status: 'adopted' }] },
      [],
    );
    expect(text).toContain('- An amendment was adopted.');
    expect(text).not.toMatch(/Rep\.|Senator|offered by|considered in/);
  });

  it('never turns an unknown status into a verdict', () => {
    const text = buildHistoryText(ohio, []);
    expect(text).not.toMatch(/adopted|rejected|withdrawn/);
    expect(text).toContain('status not stated');
  });

  it('uses each status wording', () => {
    for (const [status, phrase] of [
      ['offered', 'was offered'],
      ['rejected', 'was rejected'],
      ['withdrawn', 'was withdrawn'],
    ] as const)
      expect(
        buildHistoryText({ ...ohio, amendments: [{ id: 'x', status }] }, []),
      ).toContain(phrase);
  });

  it('shows a committee beside a named sponsor only when the record gives one', () => {
    const text = buildHistoryText(
      {
        ...ohio,
        amendments: [
          {
            id: 'x',
            status: 'adopted',
            sponsor: { name: 'Sen. Lee' },
            committee: 'Rules',
          },
        ],
      },
      [],
    );
    expect(text).toContain(
      'offered by Sen. Lee was adopted. Committee: Rules.',
    );
  });

  it('keeps the first and the latest items of a long list and counts the middle', () => {
    const actions = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      text: `Action ${String(i)}`,
    }));
    actions[26]!.text = 'Passed the Senate';
    actions[27]!.text = 'Enrolled';
    actions[28]!.text = 'Signed by the Governor';
    actions[29]!.text = 'Effective date';
    const text = buildHistoryText(
      {
        versions: [],
        actions: [...actions].reverse(),
        amendments: actions.map((_, i) => ({
          id: String(i),
          status: 'offered' as const,
          date: actions[i]!.date,
        })),
        sources: [],
      },
      [],
    );
    expect(text).toContain('Action 0');
    expect(text).toContain('- 18 actions in between are not shown.');
    for (const t of [
      'Passed the Senate',
      'Enrolled',
      'Signed by the Governor',
      'Effective date',
    ])
      expect(text).toContain(t);
    expect(text).not.toContain('Action 5');
    expect(text).toContain('- 18 amendments in between are not shown.');
  });

  it('says "1 action" in the singular', () => {
    const actions = Array.from({ length: MAX_HISTORY_ITEMS + 1 }, (_, i) => ({
      date: `2026-02-${String(i + 1).padStart(2, '0')}`,
      text: `A${String(i)}`,
    }));
    expect(
      buildHistoryText(
        { versions: [], actions, amendments: [], sources: [] },
        [],
      ),
    ).toContain('- 1 action in between is not shown.');
  });

  it('lists versions oldest first when all are dated, else in stored order', () => {
    const text = buildHistoryText(federal, []);
    expect(text.indexOf('Introduced in House')).toBeLessThan(
      text.indexOf('Reported in House'),
    );
    const undated = buildHistoryText(
      {
        ...federal,
        versions: [
          { code: 'b', label: 'Second', date: '2026-05-01' },
          { code: 'a', label: 'First' },
        ],
      },
      [],
    );
    expect(undated.indexOf('Second')).toBeLessThan(undated.indexOf('First'));
  });

  it('displays record text literally: escapes markdown and citation markers', () => {
    const text = buildHistoryText(
      {
        ...ohio,
        amendments: [
          {
            id: 'x',
            status: 'adopted',
            purpose: '**Technical** [S:sec-1] a\\b',
          },
        ],
      },
      [],
    );
    expect(text).toContain('\\*\\*Technical\\*\\* \\[S:sec-1] a\\\\b');
  });

  it('strips zero-width and bidi characters', () => {
    expect(cleanRecordText('a\u200bb\u202ec\u2066d\u200f')).toBe('abcd');
  });

  it('gives a clear answer with no history', () => {
    expect(buildHistoryText(undefined, [])).toBe(NO_HISTORY_TEXT);
    expect(NO_HISTORY_TEXT).toMatch(/GovInfo.*Ohio LIS/);
  });

  it('does not claim the bill has no amendments when the record has none', () => {
    expect(buildHistoryText({ ...ohio, amendments: [] }, [])).toContain(
      'No amendments appear in the record we found.',
    );
  });

  it('says so when the record is empty', () => {
    expect(
      buildHistoryText(
        { versions: [], actions: [], amendments: [], sources: [] },
        [],
      ),
    ).toMatch(/lists no versions, actions or amendments/);
  });

  it('adds the strike/insert sentence when spans changed, with or without history', () => {
    for (const status of ['inserted', 'deleted'] as const) {
      expect(buildHistoryText(federal, section(status))).toContain(
        STRIKE_INSERT_SENTENCE,
      );
      expect(buildHistoryText(undefined, section(status))).toContain(
        STRIKE_INSERT_SENTENCE,
      );
    }
    expect(buildHistoryText(undefined, section('unchanged'))).not.toContain(
      STRIKE_INSERT_SENTENCE,
    );
  });

  it('truncates long record text and strips control characters', () => {
    const text = buildHistoryText(
      {
        ...ohio,
        amendments: [
          {
            id: 'x',
            status: 'adopted',
            purpose: `a\u0000b\n${'x'.repeat(5000)}`,
          },
        ],
      },
      [],
    );
    expect(text).toContain('a b xxx');
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toMatch(/\u0000/);
    expect(text).toContain('...');
  });
});

describe('cleanRecordText', () => {
  it('leaves short text alone and cuts at the limit', () => {
    expect(cleanRecordText('  hello   world ')).toBe('hello world');
    expect(cleanRecordText('y'.repeat(MAX_FIELD_CHARS + 1))).toHaveLength(
      MAX_FIELD_CHARS,
    );
  });
});

describe('runHistoryChip', () => {
  it('answers with no model, streams the text and cites nothing', () => {
    const onToken = vi.fn();
    const run = runHistoryChip(getChip('history'), federal, [], onToken);
    expect(run.answer).toMatchObject({
      provider: 'none',
      model: 'history',
      citations: [],
      declined: false,
    });
    expect(run.mode).toBe('none');
    expect(onToken).toHaveBeenCalledWith(run.answer.text);
    expect(
      runHistoryChip(getChip('history'), undefined, [], undefined).answer.text,
    ).toBe(NO_HISTORY_TEXT);
  });
});
