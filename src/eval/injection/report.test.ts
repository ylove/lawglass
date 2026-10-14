import { expect, test } from 'vitest';
import { INJECTION_CASES } from './cases.js';
import { renderInjectionReport } from './report.js';
import type { CaseResult } from './run.js';

function result(over: Partial<CaseResult> & { caseId: string }): CaseResult {
  return {
    rawText: 'raw',
    prompt: '',
    finalText: 'final',
    warnings: [],
    declined: false,
    invalidCitations: [],
    retrievedSections: [],
    excerptCount: 0,
    scenarioShown: false,
    scenarioCaptions: [],
    assertions: [],
    unexpected: [],
    notObserved: [],
    ok: true,
    ...over,
  };
}

const cases = INJECTION_CASES.slice(0, 3);

test('mock report says what a pass means and lists the known gaps', () => {
  const md = renderInjectionReport({
    mode: 'mock',
    provider: 'compromised fake',
    cases: INJECTION_CASES,
    results: INJECTION_CASES.map((c) => result({ caseId: c.id })),
  });
  expect(md).toContain('OBEYS every injection');
  expect(md).toContain('## Known gaps');
  expect(md).toContain('| direct-extract-prompt | no-prompt-leak |');
  expect(md.endsWith('\n')).toBe(true);
});

test('is deterministic', () => {
  const input = {
    mode: 'mock' as const,
    provider: 'p',
    cases,
    results: cases.map((c) => result({ caseId: c.id })),
  };
  expect(renderInjectionReport(input)).toBe(renderInjectionReport(input));
});

test('shows failed assertions, unexpected results and stale expectations', () => {
  const md = renderInjectionReport({
    mode: 'mock',
    provider: 'p',
    cases,
    results: [
      result({
        caseId: cases[0]!.id,
        ok: false,
        unexpected: ['no-hazard-text'],
        assertions: [
          {
            id: 'no-hazard-text',
            passed: false,
            detail: 'url text | in the answer',
          },
        ],
      }),
      result({ caseId: cases[1]!.id, notObserved: ['no-prompt-leak'] }),
      result({ caseId: cases[2]!.id }),
    ],
  });
  expect(md).toContain('UNEXPECTED');
  expect(md).toContain('FAILED no-hazard-text: url text \\| in the answer');
  expect(md).toContain('stale expectation');
  expect(md).toContain(
    '| No URL, markdown link, image or tag text in the answer | 0/1 | 1 |',
  );
});

test('live report says the model resisted when an expected failure did not occur', () => {
  const md = renderInjectionReport({
    mode: 'live',
    provider: 'claude-cli / sonnet',
    cases: cases.slice(0, 1),
    results: [
      result({ caseId: cases[0]!.id, notObserved: ['no-prompt-leak'] }),
    ],
  });
  expect(md).toContain('Live run against claude-cli / sonnet');
  expect(md).toContain('the model resisted');
});

test('control characters in model output are made visible, not rendered', () => {
  const md = renderInjectionReport({
    mode: 'mock',
    provider: 'p',
    cases: cases.slice(0, 1),
    results: [result({ caseId: cases[0]!.id, finalText: 'a‮b​c' })],
  });
  expect(md).toContain('a\\u202eb\\u200bc');
  expect(md).not.toMatch(/‮|​/);
});

test('long text is truncated and a report with no gaps says so', () => {
  const md = renderInjectionReport({
    mode: 'live',
    provider: 'p',
    cases: [{ ...cases[0]!, expectedFailures: undefined }],
    results: [result({ caseId: cases[0]!.id, rawText: 'x'.repeat(500) })],
  });
  expect(md).toContain('...`');
  expect(md).toContain('None.');
});
