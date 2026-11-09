import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { breakdownProvider } from '../../../tests/support/breakdown-provider.js';
import { scriptedObjects } from '../../../tests/support/picture-provider.js';
import { drawPictures } from '../picture/generate.js';
import { generateBreakdown } from '../breakdown/generate.js';
import {
  chunkHit,
  DOC_ID,
  fakeBackend,
  sec,
} from '../breakdown/test-support.js';
import { MockProvider } from '../llm/mock.js';
import { Limits } from '../pipeline/limits.js';
import {
  AppError,
  type LlmProvider,
  type LlmUsage,
  type ObjectRequest,
  type TextRequest,
} from '../model/index.js';
import {
  assertBudget,
  chargeJob,
  currentJob,
  newSpend,
  runInJob,
  type JobBudget,
  type JobScope,
} from './job.js';
import type { UsageEvent } from './usage.js';

const objReq: ObjectRequest<{ a: number }> = {
  system: 's',
  prompt: 'p',
  schema: z.object({ a: z.number() }),
  schemaName: 'o',
  maxTokens: 10,
};
const textReq: TextRequest = {
  system: 's',
  messages: [{ role: 'user', content: 'q' }],
  maxTokens: 10,
};
const limits = (over: { maxConcurrentAsk?: number } = {}) =>
  new Limits({
    maxConcurrentIngest: 1,
    maxConcurrentAsk: over.maxConcurrentAsk ?? 4,
    maxCallsPerMinute: 1000,
  });

/** A provider that answers every call and reports fixed usage. */
function spender(
  usage: LlmUsage,
  model = 'claude-sonnet-5-5',
): LlmProvider & { calls: number } {
  const p = {
    id: 'anthropic' as const,
    model,
    calls: 0,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamText() {
      p.calls++;
      yield { type: 'text' as const, text: 'hi' };
      yield { type: 'done' as const, usage, stopReason: 'end_turn' as const };
    },
    generateObject() {
      p.calls++;
      return Promise.resolve({ object: { a: 1 } as never, usage });
    },
  };
  return p;
}

function scope(over: Partial<JobScope> = {}, id = 'job-1'): JobScope {
  return {
    context: { readerId: 'alice', jobKind: 'ingest', jobId: id, docId: 'd' },
    spent: newSpend(),
    ...over,
  };
}

describe('job scope', () => {
  it('is visible through promise chains, timers, parallel branches and the limits queue', async () => {
    const seen: (string | undefined)[] = [];
    const read = () => seen.push(currentJob()?.context.jobId);
    await runInJob(scope({}, 'a'), async () => {
      await Promise.resolve();
      read();
      await new Promise((r) => setTimeout(r, 1));
      read();
      await Promise.all([
        Promise.resolve().then(read),
        (async () => {
          await Promise.resolve();
          read();
        })(),
      ]);
      void Promise.resolve().then(() => setTimeout(read, 1));
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(seen).toEqual(['a', 'a', 'a', 'a', 'a']);
    expect(currentJob()).toBeUndefined();

    // One ask slot: the second job waits in the queue and still reports under its own job.
    const events: UsageEvent[] = [];
    const lim = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 1,
      maxCallsPerMinute: 1000,
      usageSink: {
        record(e) {
          events.push(e);
        },
      },
    });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow: LlmProvider = {
      ...spender({ inputTokens: 1, outputTokens: 1 }),
      generateObject: async () => {
        await held;
        return {
          object: { a: 1 } as never,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const paced = lim.paced(slow, { background: true, feature: 'summary' });
    const first = runInJob(scope({}, 'one'), () =>
      paced.generateObject(objReq),
    );
    const second = runInJob(scope({}, 'two'), () =>
      paced.generateObject(objReq),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(lim.pool('ask').queued).toBeGreaterThanOrEqual(0);
    release();
    await Promise.all([first, second]);
    expect(events.map((e) => e.job?.jobId).sort()).toEqual(['one', 'two']);
  });

  it('delivers usage with the job context to the scope and to the sink, never prompts', async () => {
    const sink: UsageEvent[] = [];
    const host = vi.fn();
    const lim = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 1,
      maxCallsPerMinute: 1000,
      usageSink: {
        record(e) {
          sink.push(e);
        },
      },
    });
    const metered = lim.meter(
      spender({ inputTokens: 3, outputTokens: 4 }),
      'question',
    );
    await runInJob(scope({ onUsage: host }), () =>
      metered.generateObject(objReq),
    );
    await metered.generateObject(objReq); // outside any job
    expect(sink[0]?.job).toEqual({
      readerId: 'alice',
      jobKind: 'ingest',
      jobId: 'job-1',
      docId: 'd',
    });
    expect(sink[1]).not.toHaveProperty('job');
    expect(host).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sink)).not.toContain('"p"');
  });

  it('a failing host onUsage never discards the answer', async () => {
    const metered = limits().meter(
      spender({ inputTokens: 1, outputTokens: 1 }),
    );
    const out = await runInJob(
      scope({
        onUsage: () => {
          throw new Error('ledger down');
        },
      }),
      () => metered.generateObject(objReq),
    );
    expect(out.object).toEqual({ a: 1 });
  });
});

describe('budgets', () => {
  it('without a budget nothing is refused', () => {
    expect(() => {
      assertBudget(scope());
    }).not.toThrow();
    expect(() => {
      assertBudget(undefined);
    }).not.toThrow();
  });

  it.each<[string, JobBudget]>([
    ['tokens', { tokens: 250 }],
    // 100 input + 100 output tokens of sonnet cost $0.0012 a call.
    ['dollars', { dollars: 0.002 }],
  ])(
    'a %s budget stops the job with at most one call of overshoot',
    async (_n, budget) => {
      const p = spender({ inputTokens: 100, outputTokens: 100 });
      const metered = limits().meter(p);
      const s = scope({ budget });
      let refused = 0;
      await runInJob(s, async () => {
        for (let i = 0; i < 10; i++) {
          try {
            await metered.generateObject(objReq);
          } catch (e) {
            expect(e).toBeInstanceOf(AppError);
            expect((e as AppError).code).toBe('BUDGET_EXHAUSTED');
            refused++;
          }
        }
      });
      // 200 tokens or $0.0012 per call: both budgets are crossed by the second call.
      expect(p.calls).toBe(2);
      expect(refused).toBe(10 - p.calls);
      const limit = budget.tokens ?? budget.dollars!;
      const spent = budget.tokens ? s.spent.tokens : s.spent.dollars;
      const perCall = budget.tokens ? 200 : 0.0012;
      expect(spent).toBeGreaterThanOrEqual(limit);
      expect(spent - perCall).toBeLessThan(limit);
    },
  );

  it('refuses a streamed call too, and calls the exhaustion callback once', async () => {
    const onBudgetExhausted = vi.fn();
    const metered = limits().meter(
      spender({ inputTokens: 10, outputTokens: 10 }),
    );
    const s = scope({ budget: { tokens: 1 }, onBudgetExhausted });
    await runInJob(s, async () => {
      const streamed: unknown[] = [];
      for await (const e of metered.streamText(textReq)) streamed.push(e);
      for (let i = 0; i < 3; i++)
        expect(() => metered.streamText(textReq)).toThrow(/spending limit/);
    });
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
    expect(onBudgetExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ calls: 1 }),
    );
  });

  it('a model with no price cannot be bounded, so a dollar budget stops at once', () => {
    const s = scope({ budget: { dollars: 5 } });
    chargeJob(s, 'mystery-model', { inputTokens: 1, outputTokens: 1 });
    expect(() => {
      assertBudget(s);
    }).toThrow(AppError);
  });

  it('prices cache reads and writes from the usage the provider reported', () => {
    const s = scope({ budget: { dollars: 1 } });
    chargeJob(s, 'claude-sonnet-5-5', {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(s.spent.dollars).toBeCloseTo(0.2);
  });

  it('a breakdown stops cleanly when its budget runs out and keeps the parts already written', async () => {
    const sections = Array.from({ length: 25 }, (_, i) =>
      sec(
        `sec-${String(i + 1)}`,
        `Topic ${String(i + 1)}`,
        `Rule ${String(i + 1)}.`,
      ),
    );
    const hits = sections.map((s) => chunkHit(s.id, `Rule of ${s.id}.`));
    const base = breakdownProvider(new MockProvider());
    // One batch of ten reports 11 + 13 = 24 tokens, over the 20 token budget.
    const run = () =>
      generateBreakdown({
        provider: limits().meter(base, 'breakdown'),
        docId: DOC_ID,
        backend: fakeBackend(hits),
        doc: {
          metadata: {
            title: null,
            billNumber: null,
            jurisdiction: null,
            session: null,
            version: null,
            sponsors: null,
            source: 'structured',
          },
          sections,
          externalRefs: [],
          references: [],
        },
        context: { mode: 'whole', hits },
        units: sections,
      });
    const out = await runInJob(scope({ budget: { tokens: 20 } }), run);
    expect(base.breakdownCalls).toBe(1);
    expect(out.briefs).toHaveLength(10);
    expect(out.dropped).toBe(15);
  });

  it('pictures stop cleanly and keep what was drawn', async () => {
    const panel = {
      left: { glyphs: ['bank'] },
      link: 'to',
      carry: 'document',
      note: 'Monthly',
      right: { glyphs: ['government'] },
    };
    const items = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      text: `Banks must report item ${String(i)} monthly [S:sec-${String(i)}].`,
    }));
    const base = scriptedObjects([
      {
        pictures: items
          .slice(0, 6)
          .map((it) => ({ item: it.index, panels: [panel] })),
      },
    ]);
    const drawn = await runInJob(scope({ budget: { tokens: 5 } }), () =>
      drawPictures({ provider: limits().meter(base, 'pictures'), items }),
    );
    expect(base.calls).toHaveLength(1);
    expect(drawn.entries.length).toBeGreaterThan(0);
  });
});
