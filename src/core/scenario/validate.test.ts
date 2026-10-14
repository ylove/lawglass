import { describe, expect, it } from 'vitest';
import type {
  Scenario,
  ScenarioFigure,
  ScenarioFrame,
} from '../model/index.js';
import {
  exampleScenario,
  scenarioExcerpts,
} from '../../../tests/synth/scenario.js';
import { validateScenario } from './validate.js';

function rejectedFrame(
  overrides: Partial<ScenarioFrame>,
  reason: string,
  index = 1,
): void {
  const scenario = exampleScenario();
  scenario.frames[index] = { ...scenario.frames[index]!, ...overrides };
  const original = structuredClone(scenario);
  const result = validateScenario(scenario, scenarioExcerpts());
  expect(result.dropped).toEqual([{ frameIndex: index, reason }]);
  expect(result.scenario?.frames).toHaveLength(3);
  expect(scenario).toEqual(original);
}

function calculated(expr = 'income * 0.04', value = 2000): ScenarioFrame {
  return {
    kind: 'effect',
    avatar: 'person-b',
    icon: 'tax',
    caption: `Example calculation: ${expr} = $${String(value)}.`,
    citations: ['sec-1'],
    figures: [{ source: 'computed', value, unit: 'USD', expr }],
  };
}

describe('scenario validation', () => {
  it('accepts a labeled profile, citation-free setup and qualitative effects without mutation', () => {
    const scenario = exampleScenario();
    expect(validateScenario(scenario, scenarioExcerpts())).toEqual({
      scenario,
      dropped: [],
    });
  });

  it.each([
    undefined,
    {},
    { ...exampleScenario(), frames: [] },
    { ...exampleScenario(), frames: exampleScenario().frames.slice(0, 2) },
    {
      ...exampleScenario(),
      frames: Array.from({ length: 5 }, () => exampleScenario().frames[0]),
    },
    {
      ...exampleScenario(),
      frames: [
        { ...exampleScenario().frames[0], icon: '<svg>' },
        ...exampleScenario().frames.slice(1),
      ],
    },
    {
      ...exampleScenario(),
      frames: [
        { ...exampleScenario().frames[0], avatar: '<img>' },
        ...exampleScenario().frames.slice(1),
      ],
    },
  ])('drops schema-invalid output whole', (scenario) => {
    expect(validateScenario(scenario, scenarioExcerpts())).toEqual({
      dropped: [{ frameIndex: -1, reason: 'schema' }],
    });
  });

  it.each([
    '<script>alert(1)</script>',
    '<svg/>',
    '&lt;img&gt;',
    '&#60;img&#62;',
    '&#x3c;svg&#x3e;',
    '`code`',
    '[click](javascript:x)',
    '![image](url)',
  ])('drops caption markup %s', (caption) => {
    rejectedFrame({ caption }, 'markup');
  });

  it('rejects markup in profile fields and figure units', () => {
    for (const field of [
      'subject',
      'label',
      'name',
      'key',
      'unit',
      'assumptionLabel',
    ]) {
      const scenario = exampleScenario();
      if (field === 'subject') scenario.subject = '<svg>';
      else if (field === 'label' || field === 'name')
        scenario.profile[field] = '<svg>';
      else if (field === 'assumptionLabel')
        scenario.profile.assumptions[0]!.label = '<svg>';
      else scenario.profile.assumptions[0]![field as 'key' | 'unit'] = '<svg>';
      expect(validateScenario(scenario, scenarioExcerpts()).dropped).toEqual([
        { frameIndex: -1, reason: 'markup' },
      ]);
    }
    rejectedFrame(
      { figures: [{ source: 'bill', value: 4, unit: '<svg>' }] },
      'markup',
    );
  });

  it.each([
    'good',
    'bad',
    'unfair',
    'harmful',
    'great',
    'terrible',
    'relief',
    'burden',
    'burdens',
    'giveaway',
  ])('drops evaluative wording %s', (word) => {
    rejectedFrame({ caption: `This is ${word}.` }, 'language');
  });

  it('rejects evaluative titles and profiles, but not substrings', () => {
    const scenario = exampleScenario();
    scenario.subject = 'Great tax bill';
    expect(
      validateScenario(scenario, scenarioExcerpts()).dropped[0]?.reason,
    ).toBe('language');
    scenario.subject = 'Goodman records';
    expect(
      validateScenario(scenario, scenarioExcerpts()).scenario,
    ).toBeDefined();
  });

  it('requires a fixed name, example label and usable unique assumption keys', () => {
    const edits: ((scenario: Scenario) => void)[] = [
      (s) => {
        s.profile.name = 'Invented';
      },
      (s) => {
        s.profile.label = 'Annual income of $50,000';
      },
      (s) => {
        s.profile.assumptions.push(s.profile.assumptions[0]!);
      },
      (s) => {
        s.profile.assumptions[0]!.key = 'income.x';
      },
      (s) => {
        s.profile.assumptions[0]!.key = 'bill_0';
      },
      (s) => {
        s.profile.label = 'Example income of $60,000';
      },
      (s) => {
        s.profile.label = 'Example income of 50000 percent';
      },
    ];
    for (const edit of edits) {
      const scenario = exampleScenario();
      edit(scenario);
      expect(validateScenario(scenario, scenarioExcerpts()).dropped).toEqual([
        { frameIndex: -1, reason: 'profile' },
      ]);
    }
  });

  it.each([
    'Alex has an income.',
    'Example: Alex must file.',
    'Example: Alex will pay tax.',
    'Example: Alex wins a yacht.',
  ])('keeps setup limited to the labeled profile: %s', (caption) => {
    rejectedFrame({ caption }, 'setup-claim', 0);
  });

  it('rejects bill figures in setup even when cited and valid', () => {
    rejectedFrame(
      { figures: [{ value: 4, unit: 'percent', source: 'bill' }] },
      'figure',
      0,
    );
  });

  it.each([
    { citations: [] },
    { citations: ['missing'] },
    { citations: ['sec-999'] },
  ])(
    'requires a valid citation on rule/effect frames: $citations',
    ({ citations }) => {
      rejectedFrame({ citations }, 'citation');
    },
  );

  it('validates only sent excerpts, including covered sections, chunk ids and ordinals', () => {
    const excerpts = scenarioExcerpts();
    excerpts[0]!.chunk.coveredSectionIds = ['sec-1', 'sec-1/a'];
    for (const citation of ['sec-1/a', excerpts[0]!.chunk.id, '1']) {
      const scenario = exampleScenario();
      scenario.frames[1]!.citations = [citation];
      expect(validateScenario(scenario, excerpts).scenario).toBeDefined();
    }
    expect(validateScenario(exampleScenario(), []).scenario).toBeUndefined();
  });

  it('keeps an intact frame with one valid citation alongside an invalid one', () => {
    const scenario = exampleScenario();
    scenario.frames[1]!.citations.push('missing');
    expect(validateScenario(scenario, scenarioExcerpts()).scenario).toEqual(
      scenario,
    );
  });

  it('matches bill amounts, rates and spelled-out durations in cited text', () => {
    for (const [value, unit, caption, text] of [
      [4, 'percent', 'The rate is 4%.', 'The rate is four percent.'],
      [10, 'years', 'The period is 10 years.', 'The period is ten years.'],
      [5000, 'USD', 'The amount is $5,000.', 'The amount is 5,000 dollars.'],
    ] as const) {
      const scenario = exampleScenario();
      scenario.frames[1] = {
        ...scenario.frames[1]!,
        caption,
        figures: [{ source: 'bill', value, unit }],
      };
      expect(
        validateScenario(scenario, scenarioExcerpts(text)).scenario?.frames,
      ).toHaveLength(4);
    }
  });

  it('rejects an invented bill figure, wrong unit or mismatched assumption', () => {
    const figures: ScenarioFigure[] = [
      { source: 'bill', value: 7, unit: 'percent' },
      { source: 'bill', value: 4, unit: 'days' },
      { source: 'assumption', value: 60000, unit: 'USD' },
      { source: 'assumption', value: 50000, unit: 'percent' },
    ];
    for (const figure of figures)
      rejectedFrame({ figures: [figure] }, 'figure');
  });

  it('does not borrow figures from uncited excerpts', () => {
    const excerpts = scenarioExcerpts('The tax office issues a form.');
    excerpts.push({
      ...scenarioExcerpts()[0]!,
      chunk: {
        ...scenarioExcerpts()[0]!.chunk,
        id: 'other',
        sectionId: 'sec-2',
      },
    });
    const scenario = exampleScenario();
    scenario.frames[1]!.figures = [
      { source: 'bill', value: 4, unit: 'percent' },
    ];
    expect(validateScenario(scenario, excerpts).dropped).toEqual([
      { frameIndex: 1, reason: 'figure' },
    ]);
  });

  it('rejects undeclared numbers, including spelled-out ones and mismatched displayed values', () => {
    for (const caption of ['The rate is 7%.', 'The period is seven years.'])
      rejectedFrame({ caption, figures: [] }, 'figure');
    rejectedFrame(
      {
        caption: 'The rate is 4%.',
        figures: [{ value: 50000, unit: 'USD', source: 'assumption' }],
      },
      'figure',
    );
    rejectedFrame(
      {
        caption: 'The rate is 50000 percent.',
        figures: [{ value: 50000, unit: 'USD', source: 'assumption' }],
      },
      'figure',
    );
  });

  it('recomputes visible calculations from named assumptions and cited percentage fractions', () => {
    const scenario = exampleScenario();
    scenario.frames[2] = calculated();
    expect(validateScenario(scenario, scenarioExcerpts()).scenario).toEqual(
      scenario,
    );
    scenario.frames[2] = calculated('50000 * 4 / 100');
    expect(validateScenario(scenario, scenarioExcerpts()).scenario).toEqual(
      scenario,
    );
    const frame = calculated('income * bill_0 / 100');
    frame.figures!.unshift({ source: 'bill', value: 4, unit: 'percent' });
    scenario.frames[2] = frame;
    expect(validateScenario(scenario, scenarioExcerpts()).scenario).toEqual(
      scenario,
    );
  });

  it('rejects wrong results, unknown inputs, invalid arithmetic, ungrounded literals and hidden calculations', () => {
    for (const frame of [
      calculated('income * 0.04', 3000),
      calculated('income * 0.07', 3500),
      calculated('unknown * 0.04'),
      calculated('income / 0'),
      calculated('50000 * 4 / 100 + 2', 2002),
      { ...calculated(), caption: 'The example amount is $2000.' },
    ])
      rejectedFrame(frame, 'figure', 2);
  });

  it('does not allow a percentage conversion constant without a cited percentage', () => {
    const scenario = exampleScenario();
    scenario.frames[2] = calculated('income / 100', 500);
    expect(
      validateScenario(scenario, scenarioExcerpts('No rate is stated.'))
        .dropped,
    ).toEqual([{ frameIndex: 2, reason: 'figure' }]);
  });
  it('requires assumption captions to say example and calculations to use a cited bill input', () => {
    rejectedFrame(
      {
        caption: 'The income is $50000.',
        figures: [{ value: 50000, unit: 'USD', source: 'assumption' }],
      },
      'figure',
    );
    const scenario = exampleScenario();
    scenario.frames[2] = calculated('income + income', 100000);
    expect(
      validateScenario(
        scenario,
        scenarioExcerpts('No amount or rate is stated.'),
      ).dropped,
    ).toEqual([{ frameIndex: 2, reason: 'figure' }]);
    scenario.frames[1] = {
      ...scenario.frames[1]!,
      caption: 'Example income is $50000.',
      figures: [{ value: 50000, unit: 'USD', source: 'assumption' }],
    };
    scenario.frames[2] = exampleScenario().frames[2]!;
    expect(validateScenario(scenario, scenarioExcerpts()).scenario).toEqual(
      scenario,
    );
  });

  it('does not strip numbers to turn a failed frame qualitative; drops the scenario below three', () => {
    const scenario = exampleScenario();
    scenario.frames.pop();
    scenario.frames[1]!.figures = [
      { value: 7, unit: 'percent', source: 'bill' },
    ];
    scenario.frames[1]!.caption = 'The rate is 7%.';
    expect(validateScenario(scenario, scenarioExcerpts())).toEqual({
      dropped: [{ frameIndex: 1, reason: 'figure' }],
    });
  });
});
