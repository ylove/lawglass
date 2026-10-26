import { afterEach, describe, expect, it, vi } from 'vitest';
import { envVar } from '../brand.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import {
  AppError,
  type ObjectRequest,
  type TextRequest,
} from '../model/index.js';
import { z } from 'zod';
import {
  Limits,
  RateCeiling,
  Semaphore,
  claudeCliPool,
  limitsConfigFromEnv,
  resetClaudeCliPool,
  resetSharedLimits,
  sharedLimits,
} from './limits.js';

const textReq: TextRequest = {
  system: 's',
  messages: [{ role: 'user', content: 'q' }],
  maxTokens: 10,
};
const objReq: ObjectRequest<{ a: number }> = {
  system: 's',
  prompt: 'p',
  schema: z.object({ a: z.number() }),
  schemaName: 'o',
  maxTokens: 10,
};
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A task that stays in flight until `finish()` is called; records peak concurrency. */
function gate() {
  const state = { running: 0, peak: 0 };
  const finishers: (() => void)[] = [];
  const task = async (): Promise<void> => {
    state.running += 1;
    state.peak = Math.max(state.peak, state.running);
    await new Promise<void>((r) => finishers.push(r));
    state.running -= 1;
  };
  return { state, task, finishOne: () => finishers.shift()?.() };
}

describe('Semaphore', () => {
  it('rejects an invalid size', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });

  it('runs at most `max` at once and queues the rest in FIFO order', async () => {
    const sem = new Semaphore(2);
    const order: number[] = [];
    const releases = await Promise.all([sem.acquire(), sem.acquire()]);
    expect(sem.inFlight).toBe(2);
    const third = sem.acquire().then((r) => {
      order.push(3);
      return r;
    });
    const fourth = sem.acquire().then((r) => {
      order.push(4);
      return r;
    });
    await tick();
    expect(order).toEqual([]); // queued, not failed
    expect(sem.queued).toBe(2);
    releases[0]();
    const r3 = await third;
    expect(order).toEqual([3]);
    expect(sem.inFlight).toBe(2); // slot handed over, never exceeds max
    r3();
    await fourth;
    expect(order).toEqual([3, 4]);
  });

  it('ignores a second call to the same release', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    const a = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false); // a double release must not mint a second slot
    a();
  });

  it('abandons an aborted waiter without taking or leaking a slot', async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const ctl = new AbortController();
    const waiting = sem.acquire(ctl.signal);
    ctl.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    expect(sem.queued).toBe(0);
    hold();
    expect(sem.inFlight).toBe(0);
  });

  it('turns a non-Error abort reason into an AbortError', async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const ctl = new AbortController();
    const waiting = sem.acquire(ctl.signal);
    ctl.abort('just a string');
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    hold();
  });

  it('rejects immediately when already aborted', async () => {
    const sem = new Semaphore(1);
    const ctl = new AbortController();
    ctl.abort();
    await expect(sem.acquire(ctl.signal)).rejects.toBeDefined();
    expect(sem.inFlight).toBe(0);
  });
});

describe('RateCeiling', () => {
  it('admits up to max per window, then throws RATE_LIMITED with a wait time', () => {
    let t = 1_000;
    const ceiling = new RateCeiling(2, () => t);
    ceiling.admit();
    t += 10_000;
    ceiling.admit();
    t += 1_000;
    let caught: unknown;
    try {
      ceiling.admit();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const err = caught as AppError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.userMessage).toBe(
      'Too many requests in the last minute (limit 2). Please wait 49 seconds and try again.',
    );
    expect(err.details).toEqual({ retryAfterSeconds: 49 });
  });

  it('admits again once the oldest call leaves the window', () => {
    let t = 0;
    const ceiling = new RateCeiling(1, () => t);
    ceiling.admit();
    t = 59_999;
    expect(() => {
      ceiling.admit();
    }).toThrow(AppError);
    t = 60_000;
    expect(() => {
      ceiling.admit();
    }).not.toThrow();
  });

  it('does not count a rejected call against the window', () => {
    let t = 0;
    const ceiling = new RateCeiling(1, () => t);
    ceiling.admit();
    for (t = 1; t < 50; t += 7)
      expect(() => {
        ceiling.admit();
      }).toThrow(AppError);
    t = 60_000;
    expect(() => {
      ceiling.admit();
    }).not.toThrow();
  });
});

/** Occupies a pool slot for the duration of `task`, as `ask` and `ingest` do. */
async function run<T>(
  limits: Limits,
  kind: 'ask' | 'ingest',
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await limits.acquire(kind, signal);
  try {
    return await task();
  } finally {
    release();
  }
}

describe('Limits', () => {
  const config = {
    maxConcurrentIngest: 2,
    maxConcurrentAsk: 4,
    maxCallsPerMinute: 100,
  };

  it('caps ingest at 2 and queues the rest instead of failing', async () => {
    const limits = new Limits(config);
    const g = gate();
    const runs = Array.from({ length: 5 }, () => run(limits, 'ingest', g.task));
    await tick();
    expect(g.state.running).toBe(2);
    while (g.state.running > 0 || limits.pool('ingest').queued > 0) {
      g.finishOne();
      await tick();
    }
    await Promise.all(runs); // all completed
    expect(g.state.peak).toBe(2);
  });

  it('caps ask at 4, and ingest and ask pools are independent', async () => {
    const limits = new Limits(config);
    const ask = gate();
    const ingest = gate();
    const runs = [
      ...Array.from({ length: 6 }, () => run(limits, 'ask', ask.task)),
      ...Array.from({ length: 3 }, () => run(limits, 'ingest', ingest.task)),
    ];
    await tick();
    expect(ask.state.running).toBe(4);
    expect(ingest.state.running).toBe(2);
    for (let i = 0; i < 20; i += 1) {
      ask.finishOne();
      ingest.finishOne();
      await tick();
    }
    await Promise.all(runs);
    expect(ask.state.peak).toBe(4);
  });

  it('releases the slot when the task throws', async () => {
    const limits = new Limits({ ...config, maxConcurrentAsk: 1 });
    await expect(
      run(limits, 'ask', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(run(limits, 'ask', () => Promise.resolve(7))).resolves.toBe(7);
  });

  it('charges the ceiling per model call, across both call styles, and fails fast past it', async () => {
    const limits = new Limits({ ...config, maxCallsPerMinute: 3 }, () => 0);
    const base = new ScriptedProvider({ objects: { o: { a: 1 } } });
    const metered = limits.meter(base);
    expect(metered.id).toBe(base.id);
    expect(metered.model).toBe(base.model);
    await collect(metered.streamText(textReq));
    await metered.generateObject(objReq);
    await collect(metered.streamText(textReq));
    expect(base.calls).toHaveLength(3);
    expect(() => metered.streamText(textReq)).toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
    await expect(metered.generateObject(objReq)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(base.calls).toHaveLength(3); // refused calls never reach the model
  });

  it('does not read the wrapped provider until a call is made (lazy providers need no key yet)', () => {
    const limits = new Limits(config, () => 0);
    const lazy = {
      get id(): never {
        throw new AppError('MISSING_KEY');
      },
      get model(): never {
        throw new AppError('MISSING_KEY');
      },
      streamText: () => {
        throw new AppError('MISSING_KEY');
      },
      generateObject: () => Promise.reject(new AppError('MISSING_KEY')),
    };
    expect(() => limits.meter(lazy)).not.toThrow();
  });

  it('charges nothing when no model call is made', () => {
    const limits = new Limits({ ...config, maxCallsPerMinute: 1 }, () => 0);
    const metered = limits.meter(new ScriptedProvider());
    for (let i = 0; i < 50; i += 1) limits.meter(new ScriptedProvider());
    expect(metered).toBeDefined(); // wrapping alone is free; only calls count
    expect(() => metered.streamText(textReq)).not.toThrow();
  });

  it('lets a queued call be abandoned by its signal', async () => {
    const limits = new Limits({ ...config, maxConcurrentAsk: 1 });
    const g = gate();
    const first = run(limits, 'ask', g.task);
    const ctl = new AbortController();
    const second = run(limits, 'ask', () => Promise.resolve(), ctl.signal);
    ctl.abort(new Error('cancelled'));
    await expect(second).rejects.toThrow('cancelled');
    g.finishOne();
    await first;
  });
});

describe('environment configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetSharedLimits();
    resetClaudeCliPool();
  });

  it('defaults to 2 ingest, 4 ask, 30 per minute', () => {
    expect(limitsConfigFromEnv({})).toEqual({
      maxConcurrentIngest: 2,
      maxConcurrentAsk: 4,
      maxCallsPerMinute: 30,
    });
  });

  it('reads overrides under the brand env prefix', () => {
    expect(
      limitsConfigFromEnv({
        [envVar('MAX_CONCURRENT_INGEST')]: '1',
        [envVar('MAX_CONCURRENT_ASK')]: ' 8 ',
        [envVar('MAX_CALLS_PER_MINUTE')]: '5',
      }),
    ).toEqual({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 8,
      maxCallsPerMinute: 5,
    });
  });

  it.each(['0', '-3', 'abc', '2.5', '', '1e3', '99999999999999999999'])(
    'ignores the invalid value %j and keeps the default',
    (value) => {
      expect(
        limitsConfigFromEnv({ [envVar('MAX_CONCURRENT_ASK')]: value })
          .maxConcurrentAsk,
      ).toBe(4);
    },
  );

  it('builds the shared limits once from the environment', () => {
    vi.stubEnv(envVar('MAX_CONCURRENT_ASK'), '1');
    resetSharedLimits();
    expect(sharedLimits().pool('ask').max).toBe(1);
    expect(sharedLimits()).toBe(sharedLimits());
  });

  it('sizes the claude subprocess pool from the environment, default 2', () => {
    resetClaudeCliPool();
    expect(claudeCliPool().max).toBe(2);
    resetClaudeCliPool();
    vi.stubEnv(envVar('MAX_CONCURRENT_CLAUDE_CLI'), '1');
    expect(claudeCliPool().max).toBe(1);
  });
});

describe('Limits.paced', () => {
  const provider = {
    id: 'mock',
    model: 'm',
    streamText: () => {
      throw new Error('unused');
    },
    generateObject: () =>
      Promise.resolve({
        object: { a: 1 },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  } as unknown as import('../model/index.js').LlmProvider;

  it('holds an ask slot only during each call', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 2,
      maxCallsPerMinute: 100,
    });
    const slow = {
      ...provider,
      generateObject: () => {
        expect(limits.pool('ask').inFlight).toBe(1);
        return Promise.resolve({
          object: { a: 1 },
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    } as unknown as typeof provider;
    const paced = limits.paced(slow, { background: true });
    await paced.generateObject(objReq);
    expect(limits.pool('ask').inFlight).toBe(0);
    expect(limits.backgroundPool().inFlight).toBe(0);
  });

  it('lets background work use at most half the slots and half the ceiling', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 2,
      maxCallsPerMinute: 4,
      backgroundWaitMs: 0,
    });
    expect(limits.backgroundPool().max).toBe(1);
    const background = limits.paced(provider, { background: true });
    const reader = limits.paced(provider);
    await background.generateObject(objReq);
    await background.generateObject(objReq);
    // Two of four calls are spent: background yields, the reader does not.
    await expect(background.generateObject(objReq)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await reader.generateObject(objReq);
    await reader.generateObject(objReq);
    await expect(reader.generateObject(objReq)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(limits.pool('ask').inFlight).toBe(0);
    expect(limits.backgroundPool().inFlight).toBe(0);
  });

  it('queues a second background call instead of taking the reader’s slot', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 2,
      maxCallsPerMinute: 100,
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = {
      ...provider,
      generateObject: async () => {
        await gate;
        return { object: { a: 1 }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as typeof provider;
    const paced = limits.paced(held, { background: true });
    const first = paced.generateObject(objReq);
    const second = paced.generateObject(objReq);
    await vi.waitFor(() => {
      expect(limits.backgroundPool().queued).toBe(1);
      expect(limits.pool('ask').inFlight).toBe(1);
    });
    (await limits.acquire('ask'))();
    open();
    await Promise.all([first, second]);
  });

  it('counts calls in the window', () => {
    let t = 0;
    const ceiling = new RateCeiling(3, () => t, 1000);
    ceiling.admit();
    ceiling.admit();
    expect(ceiling.used()).toBe(2);
    t = 1500;
    expect(ceiling.used()).toBe(0);
  });

  it('makes background work wait for the window to free instead of failing', async () => {
    let t = 0;
    const limits = new Limits(
      {
        maxConcurrentIngest: 1,
        maxConcurrentAsk: 2,
        maxCallsPerMinute: 2,
        backgroundWaitMs: 5000,
        backgroundPollMs: 5,
      },
      () => t,
    );
    const background = limits.paced(provider, { background: true });
    await background.generateObject(objReq); // used 1 of share 1
    const second = background.generateObject(objReq);
    let done = false;
    void second.then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(done).toBe(false);
    // The minute passes: the first call ages out and the waiting call goes through.
    t += 61_000;
    await second;
    expect(done).toBe(true);
  });

  it('gives up with RATE_LIMITED after the wait bound, and stops waiting when aborted', async () => {
    const limits = new Limits(
      {
        maxConcurrentIngest: 1,
        maxConcurrentAsk: 2,
        maxCallsPerMinute: 2,
        backgroundWaitMs: 30,
        backgroundPollMs: 5,
      },
      () => 0,
    );
    const background = limits.paced(provider, { background: true });
    await background.generateObject(objReq);
    await expect(background.generateObject(objReq)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    const controller = new AbortController();
    const pending = limits
      .paced(provider, { background: true })
      .generateObject({ ...objReq, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(limits.pool('ask').inFlight).toBe(0);
    expect(limits.backgroundPool().inFlight).toBe(0);
  });

  it('a request signal ends the wait for a busy background slot', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 1,
      maxConcurrentAsk: 2,
      maxCallsPerMinute: 100,
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = {
      ...provider,
      generateObject: async () => {
        await gate;
        return { object: { a: 1 }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as typeof provider;
    const paced = limits.paced(held, { background: true });
    const first = paced.generateObject(objReq);
    const controller = new AbortController();
    const queued = paced.generateObject({
      ...objReq,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(limits.backgroundPool().queued).toBe(1);
    });
    controller.abort();
    await expect(queued).rejects.toThrow();
    open();
    await first;
  });
});
