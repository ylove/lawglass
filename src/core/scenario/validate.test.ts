import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type {
  Scenario,
  ScenarioFigure,
  ScenarioFrame,
} from '../model/index.js';
import {
  exampleScenario,
  scenarioExcerpts,
} from '../../../tests/synth/scenario.js';
import { composeSetupFrames } from './profile.js';
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
    caption: `Example calculated tax is $${String(value)}.`,
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

  it.each([
    'Harmony Office',
    'bank teller',
    'benefice',
    'Burdock Road',
    'The bill relies on income',
    'Tax rule relied on',
    'Reliever pitcher',
  ])('does not treat %s as evaluative', (text) => {
    const scenario = exampleScenario();
    scenario.subject = text;
    expect(validateScenario(scenario, scenarioExcerpts()).dropped).toEqual([]);
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
      // Chunk ids and ordinals resolve at the boundary; output contains only section ids.
      expect(
        validateScenario(scenario, excerpts).scenario?.frames[1]?.citations,
      ).toEqual([citation === 'sec-1/a' ? citation : 'sec-1']);
    }
    expect(validateScenario(exampleScenario(), []).scenario).toBeUndefined();
  });

  it('keeps the caption intact but emits only valid normalized section ids', () => {
    const scenario = exampleScenario();
    scenario.frames[1]!.citations.push('missing');
    // Previously this test blessed invalid raw ids; citation chips need resolved section ids.
    const result = validateScenario(scenario, scenarioExcerpts()).scenario;
    expect(result?.frames[1]?.citations).toEqual(['sec-1']);
    expect(result?.frames[1]?.caption).toBe(scenario.frames[1]!.caption);
    expect(scenario.frames[1]!.citations).toEqual(['sec-1', 'missing']);
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

  it('recomputes structured calculations whose results are displayed', () => {
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

  it('rejects wrong results, unknown inputs, invalid arithmetic, ungrounded literals and missing results', () => {
    for (const frame of [
      calculated('income * 0.04', 3000),
      calculated('income * 0.07', 3500),
      calculated('unknown * 0.04'),
      calculated('income / 0'),
      calculated('50000 * 4 / 100 + 2', 2002),
      { ...calculated(), caption: 'The example amount is calculated.' },
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

// Review regressions are deliberately exercised against the pre-fix implementation first.
describe('PR 143 grounding regressions', () => {
  function checkFrame(frame: ScenarioFrame, text = 'The rate is 4 percent.') {
    const scenario = exampleScenario();
    scenario.frames[1] = frame;
    return validateScenario(scenario, scenarioExcerpts(text));
  }
  it.each([
    [7, 'within 7 days', 'Example fee 7. The tax is $777.'],
    [4, '4 percent', 'Example 4: the tax is $4444.'],
  ] as const)(
    'rejects bare expression %s and substring smuggling',
    (value, text, caption) => {
      const frame = calculated(String(value), value);
      frame.caption = caption;
      expect(checkFrame(frame, text).dropped).toEqual([
        { frameIndex: 1, reason: 'figure' },
      ]);
    },
  );
  it('requires every computed result to appear as a complete caption token', () => {
    const frame = calculated();
    frame.caption = 'Example: income * 0.04.';
    expect(checkFrame(frame).dropped).toEqual([
      { frameIndex: 1, reason: 'figure' },
    ]);
  });
  it.each([
    ['income * 4', '4 percent'],
    ['income * 100 * 0.04', '4 percent'],
    ['income * 4', '4 days'],
    ['income * 4', '4 years'],
    ['income * 4', '4 employees'],
  ])('rejects incompatible rate %s cited as %s', (expr, text) => {
    const frame = calculated(expr, 200000);
    // Preserve the review's displayed expression so the old code accepts this bypass.
    frame.caption = `Example: ${expr} = $200000.`;
    expect(checkFrame(frame, text).dropped).toEqual([
      { frameIndex: 1, reason: 'figure' },
    ]);
  });
  it.each(['income * 4/100', 'income * 0.04'])(
    'keeps properly converted percent %s',
    (expr) => {
      const frame = calculated(expr);
      // The calculation is stored in expr; caption numbers each need their own figure.
      frame.caption = 'Example calculated tax is $2000.';
      expect(checkFrame(frame).dropped).toEqual([]);
    },
  );
  it.each(['bill', 'computed'] as const)(
    'does not ground %s figures in deleted chunks',
    (source) => {
      const scenario = exampleScenario();
      scenario.frames[1] =
        source === 'computed'
          ? calculated()
          : {
              ...scenario.frames[1]!,
              caption: 'The rate is 4%.',
              figures: [{ source, value: 4, unit: 'percent' }],
            };
      const excerpts = scenarioExcerpts();
      excerpts[0]!.chunk.amendmentStatus = 'deleted';
      expect(validateScenario(scenario, excerpts).dropped).toEqual([
        { frameIndex: 1, reason: 'figure' },
      ]);
    },
  );
  it.each([
    'abolishes',
    'exempts',
    'waives',
    'taxes',
    'bans',
    'requires',
    'repeals',
    'raises',
    'lowers',
    'cuts',
  ])('rejects profile claims containing %s whole', (verb) => {
    const scenario = exampleScenario();
    scenario.profile.label = `Example the tax office ${verb} all tax`;
    scenario.frames[0]!.caption = `This is Alex. ${scenario.profile.label}.`;
    expect(
      validateScenario(scenario, scenarioExcerpts()).dropped,
    ).toContainEqual({ frameIndex: -1, reason: 'profile' });
  });
  it.each([
    'Example ' + 'a'.repeat(61),
    'Example a b c d e f g h',
    'Example income 50000',
    'Example: income',
  ])('rejects unconstrained profile labels %s', (label) => {
    const scenario = exampleScenario();
    scenario.profile.label = label;
    expect(
      validateScenario(scenario, scenarioExcerpts()).dropped,
    ).toContainEqual({ frameIndex: -1, reason: 'profile' });
  });
  it('constrains assumption labels too', () => {
    const scenario = exampleScenario();
    scenario.profile.assumptions[0]!.label = 'Example office abolishes tax';
    expect(validateScenario(scenario, scenarioExcerpts()).dropped).toEqual([
      { frameIndex: -1, reason: 'profile' },
    ]);
  });
  it('normalizes citation ids, removes invalid ids and de-duplicates resolved aliases', () => {
    const frame = {
      ...exampleScenario().frames[1]!,
      citations: ['sec-9', '1', scenarioExcerpts()[0]!.chunk.id, 'sec-1'],
    };
    expect(checkFrame(frame).scenario?.frames[1]?.citations).toEqual(['sec-1']);
  });
  it.each([
    'good cause',
    'fair market value',
    'fair use',
    'Fair Housing Act',
    'Tax Relief Act',
    'burden of proof',
    'in good standing',
    'bad faith',
    'good faith',
  ])('allows legal phrase %s', (phrase) => {
    expect(
      checkFrame({
        ...exampleScenario().frames[1]!,
        caption: `The rule concerns ${phrase}.`,
      }).dropped,
    ).toEqual([]);
  });
  it.each([
    'burdensome',
    'burdened',
    'relieves',
    'relieved',
    'relieving',
    'unjustified',
    'unjustifiable',
    'unjustly',
    'harmfully',
    'harmless',
    'burdensomely',
    'punishable',
    'punishment',
    'unjust',
    'harm',
    'benefits',
    'punishes',
    'windfall',
    'loophole',
    'handout',
    'crushing',
    'fairness',
  ])('rejects evaluative inflection %s', (word) => {
    expect(
      checkFrame({
        ...exampleScenario().frames[1]!,
        caption: `The bill is ${word}.`,
      }).dropped,
    ).toEqual([{ frameIndex: 1, reason: 'language' }]);
  });
  it.each([
    'One form is required',
    'No one may collect',
    'A one-time form',
    'Section 2 requires a form',
    'Sec. 2 requires a form',
    'Form 1040',
    '§ 2 requires a form',
  ])('allows qualitative label %s', (caption) => {
    expect(
      checkFrame({ ...exampleScenario().frames[1]!, caption }).dropped,
    ).toEqual([]);
  });
  it.each([
    '5k',
    '$5K',
    'half',
    '3rd',
    'a dozen',
    '１１００',
    '1e3',
    'doubles the tax',
    '$2M',
    '$3B',
  ])('audits undeclared numeric form %s', (caption) => {
    expect(
      checkFrame({ ...exampleScenario().frames[1]!, caption }).dropped,
    ).toEqual([{ frameIndex: 1, reason: 'figure' }]);
  });
  it('grounds decimal scales when the full value and unit match', () => {
    const frame = {
      ...exampleScenario().frames[1]!,
      caption: 'The amount is 1.1 million dollars.',
      figures: [{ source: 'bill' as const, value: 1100000, unit: 'USD' }],
    };
    expect(
      checkFrame(frame, 'The amount is 1.1 million dollars.').dropped,
    ).toEqual([]);
  });
  it.each([
    'http://example.test',
    'javascript:alert',
    'data:text/plain,hello',
    'www.example.test',
    'A sentence.\n# heading',
  ])('rejects URL/markdown caption %s', (caption) => {
    expect(
      checkFrame({ ...exampleScenario().frames[1]!, caption }).dropped,
    ).toEqual([{ frameIndex: 1, reason: 'markup' }]);
  });
  it('drops a scenario with only setup frames', () => {
    const scenario = exampleScenario();
    scenario.frames = Array.from({ length: 3 }, () => scenario.frames[0]!);
    expect(
      validateScenario(scenario, scenarioExcerpts()).scenario,
    ).toBeUndefined();
  });
  it('enforces validator branch coverage as well as line coverage', () => {
    const config = readFileSync(
      new URL('../../../vitest.config.ts', import.meta.url),
      'utf8',
    );
    expect(
      /'src\/core\/scenario\/validate.ts': \{([^}]+)/.exec(config)?.[1],
    ).toMatch(/branches: 90/);
  });
});

it('audits numeric expression inputs as complete caption tokens too', () => {
  rejectedFrame(
    { ...calculated(), caption: 'Example: income * 0.04 = $2000.' },
    'figure',
    2,
  );
  const frame = calculated('income + 100', 50100);
  frame.caption = 'Example: income + $100 = $50100.';
  frame.figures!.push({ source: 'bill', value: 100, unit: 'USD' });
  const scenario = exampleScenario();
  scenario.frames[2] = frame;
  expect(
    validateScenario(scenario, scenarioExcerpts('The amount is $100.')).dropped,
  ).toEqual([]);
});
it('allows literal ampersands as text and rejects full-width angle brackets', () => {
  const scenario = exampleScenario();
  scenario.frames[1]!.caption = 'Records & forms are filed.';
  expect(validateScenario(scenario, scenarioExcerpts()).dropped).toEqual([]);
  rejectedFrame({ caption: '＜svg＞' }, 'markup');
});
it('requires an exact setup template even for otherwise permitted vocabulary', () => {
  rejectedFrame(
    { caption: exampleScenario().frames[0]!.caption + ' Alex.' },
    'setup-claim',
    0,
  );
});
it.each(['inserted', 'unchanged'] as const)(
  'uses the active rate rather than a deleted rate (%s)',
  (status) => {
    const excerpts = scenarioExcerpts('The previous rate is 7 percent.');
    excerpts[0]!.chunk.amendmentStatus = 'deleted';
    excerpts.push({
      ...excerpts[0]!,
      chunk: {
        ...excerpts[0]!.chunk,
        id: 'active',
        text: 'The rate is 4 percent.',
        amendmentStatus: status,
      },
    });
    const scenario = exampleScenario();
    scenario.frames[1]!.caption = 'The rate is 4%.';
    scenario.frames[1]!.figures = [
      { source: 'bill', value: 4, unit: 'percent' },
    ];
    expect(validateScenario(scenario, excerpts).dropped).toEqual([]);
    scenario.frames[1]!.caption = 'The rate is 7%.';
    scenario.frames[1]!.figures = [
      { source: 'bill', value: 7, unit: 'percent' },
    ];
    expect(validateScenario(scenario, excerpts).dropped).toEqual([
      { frameIndex: 1, reason: 'figure' },
    ]);
  },
);

it('keeps legal benefit entitlements but rejects evaluative benefit claims', () => {
  const scenario = exampleScenario();
  for (const caption of [
    'Alex receives benefits.',
    'The benefit amount is determined by filing.',
    'The office pays unemployment benefits.',
  ]) {
    scenario.frames[1]!.caption = caption;
    expect(validateScenario(scenario, scenarioExcerpts()).dropped).toEqual([]);
  }
  rejectedFrame({ caption: 'This is beneficial.' }, 'language');
  rejectedFrame({ caption: 'The bill benefits Alex.' }, 'language');
});
it('does not permit an assumption unit to author a setup claim', () => {
  const scenario = exampleScenario();
  scenario.profile.assumptions[0]!.unit = 'abolishes all tax';
  scenario.frames[0]!.figures![0]!.unit = 'abolishes all tax';
  scenario.frames[0]!.caption =
    'This is Alex. Example employee. Example: annual income 50,000 abolishes all tax.';
  expect(validateScenario(scenario, scenarioExcerpts()).dropped).toEqual([
    { frameIndex: -1, reason: 'profile' },
  ]);
});

describe('fail-closed caption numbers in frames', () => {
  it.each([
    'The fee is a hundred dollars.',
    'The fee is a grand.',
    'Hundreds of dollars are owed.',
    'The tax is tenfold.',
    'One-half of income is owed.',
    'Example 2x the tax is owed.',
    'The fee is ١١٠٠ dollars.',
    'The fee is $٥٠٠.',
    'The fee is Ⅻ dollars.',
  ])('drops %s as a figure', (caption) => {
    rejectedFrame({ caption, figures: undefined }, 'figure');
  });
});

describe('round 3: every assumption a result relies on is visible', () => {
  const assumption = (key: string, value: number, label = 'other amount') => ({
    key,
    label,
    value,
    unit: 'USD',
  });
  it('rejects a profile with a fourth, hidden assumption used in a calculation', () => {
    const scenario = exampleScenario();
    scenario.profile.assumptions = [
      assumption('income', 50000, 'annual income'),
      assumption('savings', 1),
      assumption('rent', 2),
      assumption('ded', 10000),
    ];
    scenario.frames[2] = calculated('(income - ded) * 4 / 100', 1600);
    expect(validateScenario(scenario, scenarioExcerpts())).toEqual({
      dropped: [{ frameIndex: -1, reason: 'profile' }],
    });
  });
  it('does not let an expression name an assumption the 200-character setup caption omits', () => {
    const scenario = exampleScenario();
    const long = 'a'.repeat(60);
    scenario.profile.assumptions = [
      assumption('income', 50000, long),
      assumption('rent', 2, long),
      assumption('ded', 10000, long),
    ];
    scenario.frames[2] = calculated('(income - ded) * 4 / 100', 1600);
    expect(
      validateScenario(composeSetupFrames(scenario), scenarioExcerpts())
        .dropped,
    ).toEqual([{ frameIndex: 2, reason: 'figure' }]);
  });
  it('accepts ordinary tax-profile labels and ordinal words in setup', () => {
    const scenario = exampleScenario();
    scenario.profile.label = 'Example worker with a second job';
    scenario.profile.assumptions = [
      assumption('income', 50000, 'standard deduction'),
      assumption('vehicles', 1, 'third vehicle'),
    ];
    scenario.profile.assumptions[1]!.unit = 'count';
    expect(
      validateScenario(composeSetupFrames(scenario), scenarioExcerpts())
        .dropped,
    ).toEqual([]);
  });
});
