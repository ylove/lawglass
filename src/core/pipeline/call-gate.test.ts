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
import { gateRetry } from '../cost/attempt.js';
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
  const seen: unknown[] = [];
  for await (const event of it) seen.push(event);
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
      callGate: (call: GateCall) => {
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

  it('prices the worst case from every byte sent, with framing, and maxTokens at the model rates', async () => {
    const rate = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 4 };
    const calls: GateCall[] = [];
    const { job } = scope({
      prices: { scripted: rate },
      callGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    await runInJob(job, () =>
      drain(limits().meter(okProvider()).streamText(textReq)),
    );
    // One token per byte (a tokenizer never emits more) plus 1,024 for the request and 32 for the
    // message, at the dearest input rate (cache write, 4), plus 1,000 output tokens at 2.
    const input = 1024 + 32 + textReq.system.length + 360;
    expect(calls[0]?.worstCaseUsd).toBeCloseTo(
      (input * 4 + 1000 * 2) / 1_000_000,
      10,
    );
  });

  it('counts multi-byte text by its UTF-8 bytes, not its characters', async () => {
    const calls: GateCall[] = [];
    const { job } = scope({
      prices: {
        scripted: { input: 1, output: 0, cacheRead: 0, cacheWrite: 1 },
      },
      callGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    const text = '\u6cd5'.repeat(100); // 3 bytes each
    await runInJob(job, () =>
      drain(
        limits()
          .meter(okProvider())
          .streamText({
            system: '',
            messages: [{ role: 'user', content: text }],
            maxTokens: 1,
          }),
      ),
    );
    expect(calls[0]?.worstCaseUsd).toBeCloseTo(
      (1024 + 32 + 300) / 1_000_000,
      10,
    );
  });

  it('counts a structured-output schema twice, as adapters send it twice', async () => {
    const calls: GateCall[] = [];
    const { job } = scope({
      prices: {
        scripted: { input: 1, output: 0, cacheRead: 0, cacheWrite: 1 },
      },
      callGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    await runInJob(job, () =>
      limits().meter(okProvider()).generateObject(objReq),
    );
    const schema = JSON.stringify(z.toJSONSchema(objReq.schema)).length;
    expect(calls[0]?.worstCaseUsd).toBeCloseTo(
      (1024 + 1 + 32 + 1 + 2 * schema) / 1_000_000,
      10,
    );
  });

  it('cannot bound a part that is not text: Infinity', async () => {
    const calls: GateCall[] = [];
    const { job } = scope({
      prices: {
        scripted: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
      },
      callGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    const image = { type: 'image', data: 'x' } as unknown as { text: string };
    await runInJob(job, () =>
      drain(
        limits()
          .meter(okProvider())
          .streamText({
            system: '',
            messages: [{ role: 'user', content: [image] }],
            maxTokens: 1,
          }),
      ),
    );
    expect(calls[0]?.worstCaseUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it('is Infinity for the claude-cli provider: its subprocess has no output limit', async () => {
    const calls: GateCall[] = [];
    const { job } = scope({
      prices: {
        scripted: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
      },
      callGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    const cli = Object.assign(Object.create(okProvider()) as LlmProvider, {
      id: 'claude-cli' as const,
    });
    await runInJob(job, () => drain(limits().meter(cli).streamText(textReq)));
    expect(calls[0]?.worstCaseUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it('includes the long-context premium when the prompt is long enough', async () => {
    const tier = { input: 3, output: 6, cacheRead: 0.3, cacheWrite: 12 };
    const calls: GateCall[] = [];
    const { job } = scope({
      prices: {
        scripted: {
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite: 4,
          longContext: { aboveInputTokens: 50, ...tier },
        },
      },
      callGate: (call: GateCall) => {
        calls.push(call);
        return true;
      },
    });
    await runInJob(job, () =>
      drain(limits().meter(okProvider()).streamText(textReq)),
    );
    const prompt = 1024 + 32 + textReq.system.length + 360;
    // Over the threshold every token of the call is at the long-context rates.
    expect(calls[0]?.worstCaseUsd).toBeCloseTo(
      (prompt * 12 + 1000 * 6) / 1_000_000,
      10,
    );
  });

  it('is Infinity for a model with no price, so a capping host refuses it', async () => {
    const calls: GateCall[] = [];
    const { job } = scope({
      callGate: (call: GateCall) => {
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
      callGate: async () => {
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
    const { job } = scope({ callGate: (_call: GateCall) => gate() });
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
      callGate: async (call: GateCall) => {
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
    scope({ callGate: (_call: GateCall) => true });

  it('says reported false when a call fails before the provider billed anything', async () => {
    const { job, usage, ends } = gated();
    const metered = limits().meter(
      scripted(() =>
        (async function* () {
          await Promise.resolve();
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
          await Promise.resolve();
          yield { type: 'text', text: 'partial answer' } as const;
          yield { type: 'text', text: 'more' } as const;
        })(),
      ),
    );
    await runInJob(job, async () => {
      for await (const event of metered.streamText(textReq)) {
        expect(event.type).toBe('text');
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
          await Promise.resolve();
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
      callGate: (_call: GateCall) => true,
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

describe('aborts and timeouts', () => {
  const gated = (
    gate: (c: GateCall) => boolean | Promise<boolean> = () => true,
  ) => scope({ callGate: gate });

  /** A stream that waits for its request's abort signal, as a real provider does. */
  function hanging(seen: { signal?: AbortSignal | undefined }): LlmProvider {
    return {
      id: 'mock',
      model: 'scripted',
      streamText: (req) =>
        (async function* () {
          seen.signal = req.signal;
          yield { type: 'text', text: 'partial' } as const;
          await new Promise<never>((_, reject) => {
            const abort = () => {
              reject(new DOMException('aborted', 'AbortError'));
            };
            if (req.signal?.aborted) abort();
            else req.signal?.addEventListener('abort', abort);
          });
        })(),
      generateObject: () => Promise.reject(new Error('unused')),
    };
  }

  it('an abort mid-stream reaches the provider and ends the call once, with an estimate', async () => {
    const { job, usage, ends } = gated();
    const seen: { signal?: AbortSignal | undefined } = {};
    const controller = new AbortController();
    const metered = limits().meter(hanging(seen));
    const run = runInJob(job, async () => {
      for await (const event of metered.streamText({
        ...textReq,
        signal: controller.signal,
      })) {
        expect(event.type).toBe('text');
        controller.abort();
      }
    });
    await expect(run).rejects.toThrow('aborted');
    expect(seen.signal?.aborted).toBe(true);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ estimated: true });
    expect(ends).toEqual([
      expect.objectContaining({ callId: usage[0]?.callId, reported: true }),
    ]);
  });

  it('an abort while the gate is deciding makes no provider call and ends the call unreported', async () => {
    const controller = new AbortController();
    const provider = okProvider();
    const { job, usage, ends } = gated(async () => {
      controller.abort();
      await Promise.resolve();
      return true;
    });
    const metered = limits().meter(provider);
    await expect(
      runInJob(job, () =>
        drain(metered.streamText({ ...textReq, signal: controller.signal })),
      ),
    ).rejects.toThrow();
    await expect(
      runInJob(job, () =>
        metered.generateObject({ ...objReq, signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
    expect(usage).toHaveLength(0);
    expect(ends.map((e) => e.reported)).toEqual([false, false]);
  });

  it('a provider timeout is charged as an estimate and ends the call once', async () => {
    const { job, usage, ends } = gated();
    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    const provider: LlmProvider = {
      id: 'mock',
      model: 'scripted',
      streamText: () =>
        (async function* () {
          await Promise.resolve();
          yield* [] as LlmStreamEvent[];
          throw timeout;
        })(),
      generateObject: () => Promise.reject(timeout),
    };
    const metered = limits().meter(provider);
    await expect(
      runInJob(job, () => drain(metered.streamText(textReq))),
    ).rejects.toThrow('timed out');
    await expect(
      runInJob(job, () => metered.generateObject(objReq)),
    ).rejects.toThrow('timed out');
    expect(usage.map((u) => u.estimated)).toEqual([true, true]);
    expect(ends).toHaveLength(2);
    expect(ends.map((e) => e.reported)).toEqual([true, true]);
    expect(new Set(ends.map((e) => e.callId)).size).toBe(2);
  });
});

describe('spendGate and callGate together', () => {
  it('a () => boolean spendGate alone is checked as before and is never given a call', async () => {
    const seen: unknown[][] = [];
    const { job, usage } = scope({
      spendGate: (...args: unknown[]) => {
        seen.push(args);
        return true;
      },
      onCallEnd: undefined,
    });
    const provider = okProvider();
    await runInJob(job, () => limits().meter(provider).generateObject(objReq));
    expect(seen).toEqual([[]]);
    expect(usage).toHaveLength(1);
  });

  it('a closed spendGate refuses before the call gate is asked', async () => {
    const provider = okProvider();
    const gate = vi.fn(() => true);
    const { job } = scope({ spendGate: () => false, callGate: gate });
    await expect(
      runInJob(job, () => limits().meter(provider).generateObject(objReq)),
    ).rejects.toSatisfy(isSpendGateStop);
    expect(gate).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(0);
  });

  it('both open: each call is gated', async () => {
    const gate = vi.fn(() => true);
    const { job } = scope({ spendGate: () => true, callGate: gate });
    await runInJob(job, () =>
      limits().meter(okProvider()).generateObject(objReq),
    );
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('no gate and no hooks: calls run and nothing is asked', async () => {
    const provider = okProvider();
    await limits().meter(provider).generateObject(objReq);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('a gate that is slow or silent', () => {
  const never = () => new Promise<boolean>(() => undefined);

  it('does not outlive the reader: an abort ends the wait at once and no provider call is made', async () => {
    const controller = new AbortController();
    const provider = okProvider();
    const { job, ends } = scope({ callGate: never });
    const run = runInJob(job, () =>
      limits()
        .meter(provider)
        .generateObject({ ...objReq, signal: controller.signal }),
    );
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
    expect(ends).toHaveLength(0);
  });

  it('times out, refuses like a closed gate, and holds no slot', async () => {
    const l = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 1,
      maxCallsPerMinute: 1000,
      gateTimeoutMs: 20,
    });
    const { job } = scope({ callGate: never });
    const provider = okProvider();
    const paced = l.paced(provider);
    await expect(
      runInJob(job, () => paced.generateObject(objReq)),
    ).rejects.toSatisfy(isSpendGateStop);
    // The single ask slot is free again.
    const release = await l.acquire('ask');
    release();
    expect(provider.calls).toHaveLength(0);
  });

  it.each(['abort', 'timeout'] as const)(
    'a late approval after %s ends the call exactly once, unreported, with no provider call',
    async (how) => {
      let approve: (open: boolean) => void = () => undefined;
      const controller = new AbortController();
      const provider = okProvider();
      const l = new Limits({
        maxConcurrentIngest: 1,
        maxConcurrentAsk: 2,
        maxCallsPerMinute: 1000,
        gateTimeoutMs: how === 'timeout' ? 20 : 60_000,
      });
      const { job, ends } = scope({
        callGate: () =>
          new Promise<boolean>((resolve) => {
            approve = resolve;
          }),
      });
      const run = runInJob(job, () =>
        l
          .meter(provider)
          .generateObject({ ...objReq, signal: controller.signal }),
      );
      if (how === 'abort') controller.abort();
      await expect(run).rejects.toThrow();
      expect(ends).toHaveLength(0);
      approve(true); // the host reserved something after we gave up
      await new Promise((r) => setTimeout(r, 10));
      expect(ends).toEqual([expect.objectContaining({ reported: false })]);
      approve(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(ends).toHaveLength(1);
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('rechecks the kill switch and budget after the gate answers, before the provider', async () => {
    let killed = false;
    const provider = okProvider();
    const { job, ends } = scope({
      spendGate: () => !killed,
      callGate: () => {
        killed = true; // closed while the gate was deciding
        return true;
      },
    });
    const metered = limits().meter(provider);
    await expect(
      runInJob(job, () => metered.generateObject(objReq)),
    ).rejects.toSatisfy(isSpendGateStop);
    await expect(
      runInJob(job, async () => {
        await drain(metered.streamText(textReq));
      }),
    ).rejects.toSatisfy(isSpendGateStop);
    expect(provider.calls).toHaveLength(0);
    expect(ends.map((e) => e.reported)).toEqual([false]);
  });
});

describe('several HTTP attempts under one call', () => {
  /** A provider that needs a second request, as OpenAI does for an unsupported format. */
  function twoAttempts(): LlmProvider & { requests: number } {
    const p = {
      id: 'mock' as const,
      model: 'scripted',
      requests: 0,
      async *streamText(): AsyncIterable<LlmStreamEvent> {
        p.requests += 1;
        await gateRetry();
        p.requests += 1;
        yield { type: 'text', text: 'hi' };
        yield {
          type: 'done',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        };
      },
      generateObject: async () => {
        p.requests += 1;
        await gateRetry();
        p.requests += 1;
        return { object: { a: 1 }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return p as unknown as LlmProvider & { requests: number };
  }

  it.each(['generateObject', 'streamText'] as const)(
    '%s: each attempt is gated with its own id; usage carries the last, the first ends unreported',
    async (method) => {
      const calls: GateCall[] = [];
      const { job, usage, ends } = scope({
        callGate: (c: GateCall) => {
          calls.push(c);
          return true;
        },
      });
      const metered = limits().meter(twoAttempts());
      await runInJob(job, () =>
        method === 'streamText'
          ? drain(metered.streamText(textReq))
          : metered.generateObject(objReq),
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]?.callId).not.toBe(calls[1]?.callId);
      expect(usage.map((u) => u.callId)).toEqual([calls[1]?.callId]);
      expect(ends).toEqual([
        expect.objectContaining({ callId: calls[0]?.callId, reported: false }),
        expect.objectContaining({ callId: calls[1]?.callId, reported: true }),
      ]);
    },
  );

  it('a refused second attempt stops the call: it makes no second request and ends once each', async () => {
    let n = 0;
    const provider = twoAttempts();
    const { job, ends } = scope({
      callGate: () => ++n === 1,
    });
    await expect(
      runInJob(job, () => limits().meter(provider).generateObject(objReq)),
    ).rejects.toSatisfy(isSpendGateStop);
    expect(provider.requests).toBe(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.reported).toBe(false);
  });
});

describe('attempts keep their own context, dispatch and admission', () => {
  /** A provider that makes a second request after the gate, optionally failing it. */
  function retrying(
    afterRetry: (req: TextRequest | ObjectRequest<unknown>) => Promise<unknown>,
  ): LlmProvider & { requests: number } {
    const p = {
      id: 'mock' as const,
      model: 'scripted',
      requests: 0,
      streamText: () =>
        (async function* (): AsyncGenerator<LlmStreamEvent> {
          p.requests += 1;
          await gateRetry();
          p.requests += 1;
          yield { type: 'text', text: 'x' };
          yield {
            type: 'done',
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'end_turn',
          };
        })(),
      generateObject: async (req: ObjectRequest<unknown>) => {
        p.requests += 1;
        await gateRetry();
        p.requests += 1;
        await afterRetry(req);
        return { object: { a: 1 }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return p as unknown as LlmProvider & { requests: number };
  }

  it('an abort while a retry is gated emits no usage for the attempt that never left', async () => {
    const controller = new AbortController();
    let n = 0;
    let approveSecond: (open: boolean) => void = () => undefined;
    const { job, usage, ends } = scope({
      callGate: () =>
        ++n === 1
          ? true
          : new Promise<boolean>((resolve) => {
              approveSecond = resolve;
            }),
    });
    const provider = retrying(() => Promise.resolve());
    const run = runInJob(job, () =>
      limits()
        .meter(provider)
        .generateObject({ ...objReq, signal: controller.signal }),
    );
    await vi.waitFor(() => {
      expect(n).toBe(2);
    });
    controller.abort();
    await expect(run).rejects.toThrow();
    // Nothing was billed for the second attempt: no estimate, and the first already ended.
    expect(usage).toHaveLength(0);
    expect(provider.requests).toBe(1);
    expect(ends.map((e) => e.reported)).toEqual([false]);
    // The host approves late: that attempt ends once, unreported, with no request.
    approveSecond(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(ends.map((e) => e.reported)).toEqual([false, false]);
    expect(new Set(ends.map((e) => e.callId)).size).toBe(2);
    expect(provider.requests).toBe(1);
  });

  it('each attempt reports and ends under the reference it was gated with, even after a top-up', async () => {
    const gated: GateCall[] = [];
    const { job, usage, ends } = scope({
      callGate: (c: GateCall) => {
        gated.push(c);
        return true;
      },
    });
    const base = retrying(() => Promise.resolve());
    const topUpBetween = {
      id: base.id,
      model: base.model,
      streamText: base.streamText,
      generateObject: async () => {
        job.context.ref = 'hold-b'; // admitted again while the first request was in flight
        await gateRetry();
        return { object: { a: 1 }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as LlmProvider;
    await runInJob(job, () =>
      limits().meter(topUpBetween).generateObject(objReq),
    );
    expect(gated.map((c) => c.ref)).toEqual(['hold-1', 'hold-b']);
    expect(ends.map((e) => e.ref)).toEqual(['hold-1', 'hold-b']);
    expect(usage.map((u) => u.job?.ref)).toEqual(['hold-b']);
  });

  it('without a call gate a retry takes no extra rate admission; with one it does', async () => {
    const tight = () =>
      new Limits({
        maxConcurrentIngest: 1,
        maxConcurrentAsk: 1,
        maxCallsPerMinute: 1,
      });
    const plain = scope();
    await expect(
      runInJob(plain.job, () =>
        tight()
          .meter(retrying(() => Promise.resolve()))
          .generateObject(objReq),
      ),
    ).resolves.toBeDefined();
    const gated = scope({ callGate: () => true });
    await expect(
      runInJob(gated.job, () =>
        tight()
          .meter(retrying(() => Promise.resolve()))
          .generateObject(objReq),
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
