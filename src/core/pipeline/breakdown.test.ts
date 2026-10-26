import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { breakdownProvider } from '../../../tests/support/breakdown-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import { scenarioProvider } from '../../../tests/support/scenario-provider.js';
import { makeSectionedText } from '../../../tests/synth/index.js';
import { envVar } from '../brand.js';
import { chooseBreakdownUnits } from '../breakdown/units.js';
import { EXAMPLE_FAILED_NOTE } from '../breakdown/notes.js';
import { AppError, messageText } from '../model/index.js';
import { ingest } from './ingest.js';
import { Limits, resetSharedLimits, sharedLimits } from './limits.js';
import {
  breakdownCacheKey,
  defaultBreakdownCache,
  runBreakdown,
  runSectionExample,
  sectionExampleKey,
  type BreakdownDeps,
  type SectionExampleDeps,
} from './breakdown.js';

let env: PipelineEnv;
let docId: string;
let unitIds: string[];

beforeEach(async () => {
  env = await makePipelineEnv();
  const url = 'https://example.gov/gardens.txt';
  env.serve(url, makeSectionedText(), 'text/plain');
  docId = (
    await ingest(url, {
      backend: env.backend,
      registry: env.registry,
      provider: env.provider,
      fetcher: env.runtime.fetcher,
      now: env.runtime.now,
    })
  ).doc.docId;
  unitIds = chooseBreakdownUnits(
    (await env.registry.getDocument(docId)).sections,
  ).units.map((u) => u.id);
  vi.stubEnv(envVar('MAX_CONCURRENT_ASK'), '2');
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '100');
  resetSharedLimits();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetSharedLimits();
  await env.cleanup();
});

/** Briefs and scenarios from one provider; `scen` exposes the scenario half's counters. */
const both = () => {
  const scen = scenarioProvider(env.provider);
  return Object.assign(breakdownProvider(scen), { scen });
};

function deps(
  provider: ReturnType<typeof both> = both(),
  extra: Partial<BreakdownDeps> = {},
): BreakdownDeps {
  return {
    backend: env.backend,
    registry: env.registry,
    provider,
    endpoint: 'mock:local',
    ...extra,
  };
}

function exampleDeps(
  provider: ReturnType<typeof both> = both(),
  extra: Partial<SectionExampleDeps> = {},
): SectionExampleDeps {
  return {
    backend: env.backend,
    registry: env.registry,
    provider,
    ...extra,
  };
}

describe('runBreakdown', () => {
  it('chooses the substantive parts, skipping the short title, definitions and effective date', () => {
    expect(unitIds.length).toBeGreaterThanOrEqual(2);
    expect(unitIds).not.toContain('sec-1');
    expect(unitIds).not.toContain('sec-101');
    expect(unitIds).toContain('sec-2');
  });

  it('writes one brief per part, caches it, and a second look costs no model call', async () => {
    const provider = both();
    const first = await runBreakdown(docId, deps(provider));
    expect(first?.briefs.map((b) => b.sectionId)).toEqual(unitIds);
    expect(first?.context).toBe('whole');
    expect(provider.breakdownCalls).toBe(1);

    const again = await runBreakdown(docId, deps(provider));
    expect(again).toEqual(first);
    expect(provider.breakdownCalls).toBe(1);

    // The key carries provider, endpoint and context, so another endpoint is a miss.
    const cache = defaultBreakdownCache(env.registry);
    expect(
      await cache.get(
        breakdownCacheKey(docId, provider, 'mock:local', 'whole'),
      ),
    ).toBeDefined();
    expect(
      await cache.get(breakdownCacheKey(docId, provider, 'other', 'whole')),
    ).toBeUndefined();
    expect(
      await cache.get(
        breakdownCacheKey(docId, provider, 'mock:local', 'excerpts'),
      ),
    ).toBeUndefined();
  });

  it('records the model usage against the document', async () => {
    const before = (await env.registry.list())[0]!.usage.llmInputTokens;
    await runBreakdown(docId, deps());
    const after = (await env.registry.list())[0]!.usage.llmInputTokens;
    expect(after - before).toBe(11);
  });

  it('reads the bill in excerpt mode when whole-bill reading is off, without the cacheable prefix', async () => {
    vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '0');
    const provider = both();
    const stored = await runBreakdown(docId, deps(provider));
    expect(stored?.context).toBe('excerpts');
    expect(typeof provider.requests[0]?.prompt).toBe('string');
    expect(messageText(provider.requests[0]!.prompt)).toContain('<excerpts>');
  });

  it('background runs leave a slot free: two documents at once never fill a 2-slot pool, and a reader is served at once', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 2,
      maxCallsPerMinute: 100,
    });
    // A second, longer bill (25 parts = three batches), so the runs overlap for several calls.
    const lines = ['Many Parts Bill'];
    for (let i = 1; i <= 25; i++)
      lines.push(
        `Section ${String(i)}. Topic ${String(i)}`,
        `The department shall publish rule ${String(i)} for each grantee.`,
      );
    env.serve(
      'https://example.gov/many.txt',
      { bytes: new TextEncoder().encode(lines.join('\n')) },
      'text/plain',
    );
    const other = (
      await ingest('https://example.gov/many.txt', {
        backend: env.backend,
        registry: env.registry,
        provider: env.provider,
        fetcher: env.runtime.fetcher,
        now: env.runtime.now,
      })
    ).doc.docId;

    const provider = both();
    let peak = 0;
    const waits: number[] = [];
    provider.gate = async () => {
      peak = Math.max(peak, limits.pool('ask').inFlight);
      // A reader arrives in the middle of the runs and must not queue behind them.
      const started = Date.now();
      const release = await limits.acquire('ask');
      waits.push(Date.now() - started);
      release();
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await Promise.all([
      runBreakdown(docId, deps(provider, { limits })),
      runBreakdown(other, deps(provider, { limits })),
    ]);
    expect(provider.breakdownCalls).toBe(4);
    // One background call at a time holds at most one of the two slots, plus the reader's.
    expect(peak).toBe(1);
    expect(Math.max(...waits)).toBeLessThan(5);
    expect(limits.pool('ask').inFlight).toBe(0);
    expect(limits.backgroundPool().inFlight).toBe(0);
  });

  it('charges every model call to the per-minute ceiling and refuses background work before the reader’s headroom is gone', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 2,
      maxCallsPerMinute: 2,
      backgroundWaitMs: 0,
    });
    const provider = both();
    // One call is within the background share (half of 2); the run completes.
    await runBreakdown(docId, deps(provider, { limits }));
    expect(provider.breakdownCalls).toBe(1);
    // Half the ceiling is spent, so another background run is refused with no model call...
    vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '0');
    await expect(
      runBreakdown(docId, deps(provider, { limits })),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(provider.breakdownCalls).toBe(1);
    // ...while a reader's own call still gets the other half.
    const reader = limits.paced(provider, { background: false });
    await expect(
      reader.generateObject({
        system: 's',
        prompt: 'p',
        schema: z.looseObject({}),
        schemaName: 'other',
        maxTokens: 10,
      }),
    ).resolves.toBeDefined();
    expect(limits.pool('ask').inFlight).toBe(0);
  });

  it('does not cache a run whose briefs all failed validation', async () => {
    const provider = both();
    provider.behavior = () => ({
      briefs: unitIds.map((id) => ({
        id,
        text: 'No source.',
        example: 'none',
      })),
    });
    expect(await runBreakdown(docId, deps(provider))).toBeUndefined();
    const key = breakdownCacheKey(docId, provider, 'mock:local', 'whole');
    expect(await defaultBreakdownCache(env.registry).get(key)).toBeUndefined();
  });

  it('refuses a document that is not registered', async () => {
    await expect(runBreakdown('f'.repeat(64), deps())).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
  });
});

describe('runSectionExample', () => {
  it('draws an example from the part’s own text and caches it per part', async () => {
    const provider = both();
    const result = await runSectionExample(
      docId,
      'sec-2',
      exampleDeps(provider),
    );
    expect(result.status).toBe('ok');
    expect(result.scenario?.frames.length).toBeGreaterThanOrEqual(3);
    expect(provider.scen.scenarioCalls).toBe(1);
    // The part's own text is in the prompt, and nothing from unrelated parts.
    const prompt = provider.scen.prompts[0]!;
    expect(prompt).toContain('<focus>sec-2</focus>');
    expect(prompt).toContain('section="sec-2"');
    expect(prompt).not.toContain('Each grantee shall file an annual report.');

    await runSectionExample(docId, 'sec-2', exampleDeps(provider));
    expect(provider.scen.scenarioCalls).toBe(1);
  });

  it('keeps a separate cached example for each part', async () => {
    const provider = both();
    const other = unitIds.find((id) => id !== 'sec-2')!;
    await runSectionExample(docId, 'sec-2', exampleDeps(provider));
    await runSectionExample(docId, other, exampleDeps(provider));
    expect(provider.scen.scenarioCalls).toBe(2);
    expect(sectionExampleKey(docId, 'sec-2', provider, 'whole')).not.toEqual(
      sectionExampleKey(docId, other, provider, 'whole'),
    );
  });

  it('answers none with our own sentence when the validator rejects the example', async () => {
    const provider = both();
    provider.scen.behavior = () =>
      Promise.resolve({
        object: { not: 'a scenario' },
        usage: { inputTokens: 1, outputTokens: 1 },
      }) as never;
    const result = await runSectionExample(
      docId,
      'sec-2',
      exampleDeps(provider),
    );
    expect(result).toEqual({ status: 'none', note: EXAMPLE_FAILED_NOTE });
  });

  it('does not turn a provider failure into a none: it throws and caches nothing', async () => {
    const provider = both();
    provider.scen.behavior = () =>
      Promise.reject(new AppError('PROVIDER_ERROR'));
    await expect(
      runSectionExample(docId, 'sec-2', exampleDeps(provider)),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    provider.scen.behavior = undefined;
    const retry = await runSectionExample(
      docId,
      'sec-2',
      exampleDeps(provider),
    );
    expect(retry.status).toBe('ok');
  });

  it('refuses a part that is not one of the breakdown’s units', async () => {
    const provider = both();
    await expect(
      runSectionExample(docId, 'sec-1', exampleDeps(provider)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      runSectionExample(docId, 'nope', exampleDeps(provider)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(provider.scen.scenarioCalls).toBe(0);
  });

  it('shares the ask pool and the per-minute ceiling', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 1,
      maxCallsPerMinute: 1,
    });
    const provider = both();
    await runSectionExample(docId, 'sec-2', exampleDeps(provider, { limits }));
    const other = unitIds.find((id) => id !== 'sec-2')!;
    // The ceiling is spent: the refusal is a failure to report, not a "no example" to cache.
    await expect(
      runSectionExample(docId, other, exampleDeps(provider, { limits })),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(provider.scen.scenarioCalls).toBe(1);
    expect(limits.pool('ask').inFlight).toBe(0);
    expect(sharedLimits().pool('ask').inFlight).toBe(0);
  });
});
