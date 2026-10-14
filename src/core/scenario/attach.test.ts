import { describe, expect, it } from 'vitest';
import { MockProvider } from '../llm/mock.js';
import { AppError } from '../model/index.js';
import { scenarioProvider } from '../../../tests/support/scenario-provider.js';
import { scenarioExcerpts } from '../../../tests/synth/scenario.js';
import { addScenarioUsage, attachScenario } from './attach.js';

function provider() {
  return scenarioProvider(new MockProvider());
}

describe('attachScenario', () => {
  it('returns the scenario and the tokens it cost', async () => {
    const p = provider();
    const result = await attachScenario({
      provider: p,
      hits: scenarioExcerpts(),
    });
    expect(result.scenario?.frames.length).toBeGreaterThanOrEqual(3);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(p.scenarioCalls).toBe(1);
  });

  it('makes no call without live excerpts', async () => {
    const p = provider();
    const [hit] = scenarioExcerpts();
    const deleted = {
      ...hit!,
      chunk: { ...hit!.chunk, amendmentStatus: 'deleted' as const },
    };
    expect(await attachScenario({ provider: p, hits: [deleted] })).toEqual({
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(p.scenarioCalls).toBe(0);
  });

  it('swallows provider failures', async () => {
    const p = provider();
    p.behavior = () => Promise.reject(new AppError('PROVIDER_ERROR'));
    const result = await attachScenario({
      provider: p,
      hits: scenarioExcerpts(),
    });
    expect(result.scenario).toBeUndefined();
  });

  it('gives up after the timeout', async () => {
    const p = provider();
    p.behavior = (req) =>
      new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const result = await attachScenario({
      provider: p,
      hits: scenarioExcerpts(),
      timeoutMs: 20,
    });
    expect(result.scenario).toBeUndefined();
  });

  it('stops when the caller aborts', async () => {
    const p = provider();
    const controller = new AbortController();
    controller.abort();
    const result = await attachScenario({
      provider: p,
      hits: scenarioExcerpts(),
      signal: controller.signal,
    });
    expect(result.scenario).toBeUndefined();
  });

  it('drops an ungrounded scenario but still counts its tokens', async () => {
    const p = provider();
    // An empty frame list fails schema parsing, so nothing survives.
    const result = await attachScenario({
      provider: {
        ...p,
        generateObject: (req) =>
          p.generateObject(req).then((r) => ({
            ...r,
            object: { ...(r.object as object), frames: [] } as typeof r.object,
          })),
      },
      hits: scenarioExcerpts(),
    });
    expect(result.scenario).toBeUndefined();
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});

describe('excerpt choice', () => {
  const many = () =>
    Array.from({ length: 10 }, (_, i) => {
      const [hit] = scenarioExcerpts(`Text number ${String(i + 1)}.`);
      return {
        ...hit!,
        chunk: {
          ...hit!.chunk,
          id: `d:sec-${String(i + 1)}:0`,
          sectionId: `sec-${String(i + 1)}`,
        },
      };
    });

  it('prefers hits from cited sections, then tops up in order', async () => {
    const p = provider();
    await attachScenario({
      provider: p,
      hits: many(),
      citedSectionIds: ['sec-9', 'sec-10'],
    });
    const prompt = p.prompts[0]!;
    const sections = [...prompt.matchAll(/section="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(sections).toEqual([
      'sec-9',
      'sec-10',
      'sec-1',
      'sec-2',
      'sec-3',
      'sec-4',
      'sec-5',
      'sec-6',
    ]);
  });

  it('keeps the first eight when nothing is cited', async () => {
    const p = provider();
    await attachScenario({ provider: p, hits: many() });
    const sections = [...p.prompts[0]!.matchAll(/section="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(sections).toHaveLength(8);
    expect(sections[0]).toBe('sec-1');
  });

  it('matches a cited section covered by a synthetic excerpt', async () => {
    const p = provider();
    const hits = many();
    hits[9]!.chunk = {
      ...hits[9]!.chunk,
      sectionId: 'unit',
      coveredSectionIds: ['unit', 'sec-77'],
    };
    await attachScenario({ provider: p, hits, citedSectionIds: ['sec-77'] });
    expect(p.prompts[0]).toMatch(/^[\s\S]*?section="unit"/);
  });
});

it('adds usage without mutating', () => {
  const a = { inputTokens: 1, outputTokens: 2 };
  expect(addScenarioUsage(a, { inputTokens: 3, outputTokens: 4 })).toEqual({
    inputTokens: 4,
    outputTokens: 6,
  });
  expect(a).toEqual({ inputTokens: 1, outputTokens: 2 });
});
