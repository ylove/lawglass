import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { breakdownProvider } from '../tests/support/breakdown-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../tests/support/pipeline-env.js';
import { scenarioProvider } from '../tests/support/scenario-provider.js';
import { createSessionTestApp } from '../tests/support/session-app.js';
import { envVar } from '../src/core/brand.js';
import type { LlmProvider, ObjectRequest } from '../src/core/model/index.js';
import { resetSharedLimits } from '../src/core/pipeline/limits.js';
import { formatCoverage, runCoveragePass } from './coverage-pass.js';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '100000');
  resetSharedLimits();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  vi.unstubAllEnvs();
  resetSharedLimits();
  await env.cleanup();
});

/** Draws a one-panel picture for every item it is sent, except the item numbers in `refuse`. */
function pictureProvider(refuseText: string): LlmProvider {
  return {
    id: 'anthropic',
    model: 'claude-haiku-5-5',

    async *streamText() {
      await Promise.resolve();
      throw new Error('not scripted');
    },
    generateObject<T>(req: ObjectRequest<T>) {
      // Items are numbered from 0 in each call; the text says which brief each one is.
      const items = [
        ...JSON.stringify(req.prompt).matchAll(
          /<item n=\\"(\d+)\\">([^<]*)<\/item>/g,
        ),
      ]
        .filter((m) => !(m[2] ?? '').includes(refuseText))
        .map((m) => Number(m[1]));
      return Promise.resolve({
        object: {
          pictures: items.map((item) => ({
            item,
            panels: [
              {
                left: { glyphs: ['bank'] },
                link: 'to',
                carry: 'coins',
                right: { glyphs: ['person'] },
              },
            ],
          })),
        } as T,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  };
}

function manySections(count: number) {
  const lines = ['Synthetic Many Parts Bill'];
  for (let i = 1; i <= count; i++)
    lines.push(
      `Section ${String(i)}. Topic ${String(i)}`,
      `The department shall publish rule number ${String(i)} for each grantee.`,
    );
  lines.push('');
  return { bytes: new TextEncoder().encode(lines.join('\n')) };
}

describe('coverage pass against the mock provider', () => {
  test('ingests a bill and reports eligible briefs, pictures, examples and drop reasons', async () => {
    const bill = 'https://example.gov/pass.txt';
    env.serve(bill, manySections(34), 'text/plain');
    const answers = breakdownProvider(scenarioProvider(env.provider));
    // Two parts have nothing to illustrate; one picture is refused.
    answers.noExample.add('sec-3').add('sec-4');
    Object.assign(env.runtime, { answerProvider: answers });
    Object.defineProperty(env.runtime, 'extractProvider', {
      get: () => pictureProvider('for sec-6.'),
      configurable: true,
    });
    const app = createSessionTestApp(env.runtime, {
      localOnly: false,
      summaryWaitMs: 20,
      breakdownMaxUnits: 'all',
      pregenerateExamples: 'all',
    });

    const lines: string[] = [];
    const [report] = await runCoveragePass({
      server: 'http://127.0.0.1/',
      bills: [bill],
      fetch: ((input: Request | string | URL, init?: RequestInit) =>
        app.request(input, init)) as typeof fetch,
      pollMs: 10,
      stallMs: 15_000,
      log: (line) => lines.push(line),
    });

    expect(report?.error).toBeUndefined();
    expect(report?.briefs).toBe(34);
    expect(report?.omitted).toBe(0);
    expect(report?.eligible).toBe(32);
    expect(report?.withExample).toBe(32);
    expect(report?.withPicture).toBe(31);
    expect(report?.withBoth).toBe(31);
    expect(report?.dropReasons).toEqual({
      'picture: not drawn or refused by the checks': 1,
    });

    const text = formatCoverage([report!]);
    expect(text).toContain('eligible briefs (example available): 32');
    expect(text).toContain('with a picture: 31 (97%)');
    expect(text).toContain('with an example: 32 (100%)');
    expect(text).toContain(
      'drop reasons: picture: not drawn or refused by the checks x1',
    );
  }, 60_000);

  test('a bill that cannot be ingested is reported, not thrown', async () => {
    const app = createSessionTestApp(env.runtime, { localOnly: false });
    const [report] = await runCoveragePass({
      server: 'http://127.0.0.1/',
      bills: ['https://example.gov/missing.txt'],
      fetch: ((input: Request | string | URL, init?: RequestInit) =>
        app.request(input, init)) as typeof fetch,
      pollMs: 5,
    });
    expect(report?.error).toBeTruthy();
    expect(formatCoverage([report!])).toContain('error:');
  });
});
