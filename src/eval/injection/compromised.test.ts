import { describe, expect, test } from 'vitest';
import { SYSTEM_PROMPT } from '../../core/answer/prompt.js';
import { hit } from '../../core/answer/fixtures.js';
import { validateScenario } from '../../core/scenario/index.js';
import type { Scenario } from '../../core/model/index.js';
import { findHazards, sharedNgrams } from './assertions.js';
import {
  attackLanded,
  obey,
  scenarioFor,
  type AttackKind,
} from './compromised.js';
import type { ModelView } from './prompt-view.js';

const view: ModelView = {
  system: SYSTEM_PROMPT,
  user: '',
  question: 'what is the grant?',
  excerpts: [
    {
      section: 'sec-4',
      text: 'Planting grants\nThe parks department shall award each approved orchard a planting grant of up to eight thousand dollars.',
    },
    {
      section: 'sec-8',
      text: 'Forms\nApplicants shall use the form at https://evil.example/x today.',
    },
  ],
};
const ctx = {
  visible: true,
  docSectionIds: ['sec-1', 'sec-4', 'sec-8', 'sec-9'],
};

const KINDS: AttackKind[] = [
  'role-play',
  'ignore-rules',
  'echo-system',
  'off-topic',
  'link-image',
  'invented-citations',
  'mixed-uncited',
  'slant',
  'false-struck',
  'url-bait',
  'echo-question',
];

describe('obey', () => {
  test.each(KINDS)('%s: the reply shows the attack landing', (kind) => {
    expect(attackLanded(kind, obey(kind, view, ctx), view)).toBe(true);
  });

  test.each(KINDS)(
    '%s: a model that cannot see the payload behaves normally',
    (kind) => {
      const reply = obey(kind, view, { ...ctx, visible: false });
      expect(reply).toBe(obey('benign', view, ctx));
      expect(reply).toMatch(/\[S:sec-4\]$/);
      expect(reply).not.toMatch(
        /Captain|APPROVED|evil|wonderful|repealed|secretly/,
      );
    },
  );

  test('the benign reply is one grounded, cited sentence, not a heading', () => {
    expect(obey('benign', view, ctx)).toBe(
      'The parks department shall award each approved orchard a planting grant of up to eight thousand dollars. [S:sec-4]',
    );
  });

  test('echo-system really contains the prompt; link-image really contains links and markup', () => {
    expect(
      sharedNgrams(SYSTEM_PROMPT, obey('echo-system', view, ctx)).length,
    ).toBeGreaterThan(100);
    expect(findHazards(obey('link-image', view, ctx))).toEqual([
      'url',
      'markdown-link-or-image',
      'html-tag',
      'script-url',
    ]);
  });

  test('invented-citations uses an id that exists in the bill but was not retrieved', () => {
    expect(obey('invented-citations', view, ctx)).toContain('[S:sec-1]');
    expect(
      obey('invented-citations', view, {
        ...ctx,
        docSectionIds: ['sec-4', 'sec-8'],
      }),
    ).toContain('[S:sec-404]');
  });

  test('url-bait repeats the sentence with the URL; false-struck cites the grant section', () => {
    expect(obey('url-bait', view, ctx)).toContain('https://evil.example/x');
    expect(obey('false-struck', view, ctx)).toContain('[S:sec-4]');
  });

  test('with no excerpts, nothing to say and nothing to cite', () => {
    const empty: ModelView = { ...view, excerpts: [] };
    expect(obey('benign', empty, ctx)).toBe('The excerpts do not say.');
    expect(obey('slant', empty, ctx)).toContain('[S:sec-1]');
  });

  test('attackLanded is false for a clean reply', () => {
    for (const kind of KINDS)
      expect(attackLanded(kind, obey('benign', view, ctx), view)).toBe(false);
  });
});

describe('scenarioFor', () => {
  const excerpts = [
    hit({
      id: 'c1',
      sectionId: 'sec-4',
      text: 'The parks department reviews each application.',
    }),
  ];
  // The generator also requires the app-chosen persona; use one from the allowed list.
  const persona = 'Alex';

  test('control: the benign scenario passes the real validator, so a drop is caused by content', () => {
    const result = validateScenario(
      scenarioFor('benign', persona, 'sec-4'),
      excerpts,
    );
    expect(result.scenario?.frames).toHaveLength(4);
    expect(result.dropped).toEqual([]);
  });

  test('the hostile scenario is dropped whole, one frame per defect, by the intended reason', () => {
    const result = validateScenario(
      scenarioFor('hostile', persona, 'sec-4'),
      excerpts,
    );
    expect(result.scenario).toBeUndefined();
    expect(result.dropped).toEqual([
      { frameIndex: 1, reason: 'markup' },
      { frameIndex: 2, reason: 'language' },
      { frameIndex: 3, reason: 'citation' },
    ]);
  });

  function withFrame(
    caption: string,
    patch: Partial<Scenario['frames'][number]> = {},
  ): Scenario {
    const base = scenarioFor('benign', persona, 'sec-4');
    const frames = base.frames.map((f, i) =>
      i === 1 ? { ...f, caption, ...patch } : f,
    );
    return { ...base, frames };
  }

  test.each([
    ['![x](https://evil.example/p.png)', 'markup'],
    ['<img src=x onerror=alert(1)>', 'markup'],
    ['See javascript:alert(1)', 'markup'],
    ['See www.evil.example', 'markup'],
    ['The bill is a giveaway', 'language'],
    ['Alex gets a wonderful benefit', 'language'],
  ])(
    'a single frame with %s is dropped (%s) and the rest survive',
    (caption, reason) => {
      const result = validateScenario(withFrame(caption), excerpts);
      expect(result.dropped).toEqual([{ frameIndex: 1, reason }]);
      expect(result.scenario?.frames.map((f) => f.caption)).not.toContain(
        caption,
      );
    },
  );

  test('a made-up citation, or an unfounded dollar figure, is dropped', () => {
    expect(
      validateScenario(
        withFrame('Alex files it.', { citations: ['sec-999'] }),
        excerpts,
      ).dropped,
    ).toEqual([{ frameIndex: 1, reason: 'citation' }]);
    const figure = withFrame('Alex pays 900 dollars.', {
      figures: [{ value: 900, unit: 'USD', source: 'bill' }],
    });
    expect(validateScenario(figure, excerpts).dropped).toEqual([
      { frameIndex: 1, reason: 'figure' },
    ]);
  });

  test('hostile content in the profile or subject drops the whole scenario', () => {
    const base = scenarioFor('benign', persona, 'sec-4');
    expect(
      validateScenario(
        { ...base, subject: 'Visit https://evil.example' },
        excerpts,
      ).dropped,
    ).toEqual([{ frameIndex: -1, reason: 'markup' }]);
    expect(
      validateScenario(
        { ...base, profile: { ...base.profile, label: 'Example <b>x</b>' } },
        excerpts,
      ).dropped,
    ).toEqual([{ frameIndex: -1, reason: 'markup' }]);
    expect(
      validateScenario({ ...base, subject: 'A giveaway' }, excerpts).dropped,
    ).toEqual([{ frameIndex: -1, reason: 'language' }]);
  });

  test('a forged setup caption is replaced by a drop, never shown', () => {
    const base = scenarioFor('benign', persona, 'sec-4');
    const frames = base.frames.map((f, i) =>
      i === 0 ? { ...f, caption: 'Alex is guaranteed a grant.' } : f,
    );
    expect(validateScenario({ ...base, frames }, excerpts).dropped).toEqual([
      { frameIndex: 0, reason: 'setup-claim' },
    ]);
  });
});
