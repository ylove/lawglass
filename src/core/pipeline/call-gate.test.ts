/** The per-call spend gate and call-end notices (issue #435), at the metering seam. */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import {
  isSpendGateStop,
  newSpend,
  runInJob,
  type CallEnd,
  type GateCall,
  type JobScope,
} from '../cost/index.js';
import type { UsageEvent } from '../cost/usage.js';
import {
  AppError,
  type LlmProvider,
  type LlmStreamEvent,
  type ObjectRequest,
  type TextRequest,
} from '../model/index.js';
import { Limits } from './limits.js';

const textReq: TextRequest = {
  system: 's'.repeat(40),
  messages: [{ role: 'user', content: 'q'.repeat(360) }],
  maxTokens: 1000,
};
const objReq: ObjectRequest<{ a: number }> = {
  system: 's',
  prompt: 'p',
  schema: z.object({ a: z.number() }),
  schemaName: 'o',
  maxTokens: 500,
};
const okProvider = () => new ScriptedProvider({ objects: { o: { a: 1 } } });
const limits = () =>
  new Limits({
    maxConcurrentIngest: 4,
    maxConcurrentAsk: 8,
    maxCallsPerMinute: 1000,
  });
async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) void _;
}

function scope(extra: Partial<JobScope> = {}): {
  job: JobScope;
  usage: UsageEvent[];
  ends: CallEnd[];
} {
  const usage: UsageEvent[] = [];
  const ends: CallEnd[] = [];
  const job: JobScope = {
    context: {
      readerId: 'alice',
      jobKind: 'question',
      jobId: 'job-1',
      docId: 'doc-1',
      ref: 'hold-1',
    },
    spent: newSpend(),
    onUsage: (e) => {
      usage.push(e);
    },
    onCallEnd: (e) => {
      ends.push(e);
    },
    ...extra,
  };
  return { job, usage, ends };
}

describe('per-call gate', () => {
  it('is asked once per call with the job, a unique id and the worst-case dollars', async () => {
    const calls: GateCall[] = [];
    const { job, usage, ends } = scope({
      spendGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    const metered = limits().meter(okProvider(), 'question');
    await runInJob(job, async () => {
      await drain(metered.streamText(textReq));
      await metered.generateObject(objReq);
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      ref: 'hold-1',
      jobKind: 'question',
      docId: 'doc-1',
    });
    expect(calls[0]?.callId).not.toBe(calls[1]?.callId);
    expect(calls[0]?.model).toBe('scripted');
    // Same ids on the usage events and the call ends, in the same order.
    expect(usage.map((u) => u.callId)).toEqual(calls.map((c) => c.callId));
    expect(ends).toEqual([
      expect.objectContaining({ callId: calls[0]?.callId, reported: true }),
      expect.objectContaining({ callId: calls[1]?.callId, reported: true }),
    ]);
  });

  it('prices the worst case from the prompt and maxTokens at the model rates', async () => {
    const rate = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 4 };
    const calls: GateCall[] = [];
    const { job } = scope({
      prices: { scripted: rate },
      spendGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    await runInJob(job, () =>
      drain(limits().meter(okProvider()).streamText(textReq)),
    );
    // About 110 prompt tokens at the dearest input rate (cache write, 4) plus 1,000 at 2.
    const prompt = Math.ceil(
      (textReq.system.length + JSON.stringify(textReq.messages).length) / 4,
    );
    expect(calls[0]?.worstCaseUsd).toBeCloseTo(
      (prompt * 4 + 1000 * 2) / 1_000_000,
      10,
    );
  });

  it('is Infinity for a model with no price, so a capping host refuses it', async () => {
    const calls: GateCall[] = [];
    const { job } = scope({
      spendGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    await runInJob(job, () =>
      limits().meter(okProvider()).generateObject(objReq),
    );
    expect(calls[0]?.worstCaseUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it('is awaited: an async gate that says no stops the call before the provider is touched', async () => {
    const provider = okProvider();
    const { job, usage, ends } = scope({
      spendGate: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return false;
      },
    });
    const metered = limits().meter(provider);
    const attempt = runInJob(job, async () => {
      await drain(metered.streamText(textReq));
    });
    const error: unknown = await attempt.catch((e: unknown) => e);
    expect(isSpendGateStop(error)).toBe(true);
    await expect(
      runInJob(job, () => metered.generateObject(objReq)),
    ).rejects.toSatisfy(isSpendGateStop);
    expect(provider.calls).toHaveLength(0);
    // Nothing ran, so there is nothing to report or end.
    expect(usage).toHaveLength(0);
    expect(ends).toHaveLength(0);
    expect(job.spent.refusal).toBe('spend_gate');
  });

  it.each([
    ['anything but true', () => 'yes' as unknown as boolean],
    [
      'a throw',
      () => {
        throw new Error('db down');
      },
    ],
    ['a rejection', () => Promise.reject(new Error('db down'))],
  ])('refuses on %s', async (_name, gate) => {
    const provider = okProvider();
    const { job } = scope({ spendGate: (_call: GateCall) => gate() });
    await expect(
      runInJob(job, () => limits().meter(provider).generateObject(objReq)),
    ).rejects.toSatisfy(isSpendGateStop);
    expect(provider.calls).toHaveLength(0);
  });

  it('gates each of several parallel calls, with its own id', async () => {
    const ids: string[] = [];
    let open = 0;
    let peak = 0;
    const { job, usage } = scope({
      spendGate: async (call: GateCall) => {
        ids.push(call.callId);
        open += 1;
        peak = Math.max(peak, open);
        await new Promise((r) => setTimeout(r, 5));
        open -= 1;
        return true;
      },
    });
    const metered = limits().meter(okProvider());
    await runInJob(job, () =>
      Promise.all(
        Array.from({ length: 6 }, () => metered.generateObject(objReq)),
      ),
    );
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // The server does not serialize the gate: all six were asked at once.
    expect(peak).toBe(6);
    expect(new Set(usage.map((u) => u.callId))).toEqual(new Set(ids));
  });
});

/** A provider whose calls end however the test says. */
function scripted(
  run: (req: TextRequest) => AsyncGenerator<LlmStreamEvent>,
): LlmProvider {
  return {
    id: 'mock',
    model: 'scripted',
    streamText: (req) => run(req),
    generateObject: () => Promise.reject(new AppError('FETCH_FAILED')),
  };
}

describe('call end notices', () => {
  const gated = (): ReturnType<typeof scope> =>
    scope({ spendGate: (_call: GateCall) => true });

  it('says reported false when a call fails before the provider billed anything', async () => {
    const { job, usage, ends } = gated();
    const metered = limits().meter(
      scripted(() =>
        (async function* () {
          yield* [] as LlmStreamEvent[];
          throw new AppError('FETCH_FAILED');
        })(),
      ),
    );
    await expect(
      runInJob(job, () => drain(metered.streamText(textReq))),
    ).rejects.toThrow();
    await expect(
      runInJob(job, () => metered.generateObject(objReq)),
    ).rejects.toThrow();
    expect(usage).toHaveLength(0);
    expect(ends.map((e) => e.reported)).toEqual([false, false]);
  });

  it('says reported true with an estimate when the reader leaves mid-answer', async () => {
    const { job, usage, ends } = gated();
    const metered = limits().meter(
      scripted(() =>
        (async function* () {
          yield { type: 'text', text: 'partial answer' } as const;
          yield { type: 'text', text: 'more' } as const;
        })(),
      ),
    );
    await runInJob(job, async () => {
      for await (const _ of metered.streamText(textReq)) {
        void _;
        break;
      }
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ estimated: true });
    expect(ends).toEqual([
      expect.objectContaining({ callId: usage[0]?.callId, reported: true }),
    ]);
  });

  it('a stream cut off with no text and no usage is unreported', async () => {
    const { job, ends } = gated();
    const metered = limits().meter(
      scripted(() =>
        (async function* () {
          yield* [] as LlmStreamEvent[];
          throw new Error('socket closed');
        })(),
      ),
    );
    await expect(
      runInJob(job, () => drain(metered.streamText(textReq))),
    ).rejects.toThrow('socket closed');
    expect(ends).toEqual([expect.objectContaining({ reported: false })]);
  });

  it('a host that throws in onCallEnd cannot change the call result', async () => {
    const { job } = scope({
      spendGate: (_call: GateCall) => true,
      onCallEnd: () => {
        throw new Error('bookkeeping failed');
      },
    });
    const result = await runInJob(job, () =>
      limits().meter(okProvider()).generateObject(objReq),
    );
    expect(result.object).toBeDefined();
  });
});

describe('zero-parameter hosts are unchanged', () => {
  it('a () => boolean gate is checked as before and is not given a call', async () => {
    const seen: unknown[][] = [];
    const gate = vi.fn((...args: unknown[]) => {
      seen.push(args);
      return true;
    });
    // `vi.fn` has no parameters of its own: a plain zero-arg host.
    const legacy = () => (gate() ? true : false);
    const { job, usage } = scope({ spendGate: legacy, onCallEnd: undefined });
    const provider = okProvider();
    await runInJob(job, () => limits().meter(provider).generateObject(objReq));
    expect(gate).toHaveBeenCalled();
    expect(seen[0]).toEqual([]);
    expect(usage).toHaveLength(1);
  });

  it('a closed zero-arg gate refuses before the provider, as before', async () => {
    const provider = okProvider();
    const { job } = scope({ spendGate: () => false });
    await expect(
      runInJob(job, () => limits().meter(provider).generateObject(objReq)),
    ).rejects.toSatisfy(isSpendGateStop);
    expect(provider.calls).toHaveLength(0);
  });

  it('no gate and no hooks: calls run and nothing is asked', async () => {
    const provider = okProvider();
    await limits().meter(provider).generateObject(objReq);
    expect(provider.calls).toHaveLength(1);
  });
});
