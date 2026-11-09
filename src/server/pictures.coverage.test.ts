/** Pictures drawn a group of briefs at a time under full coverage (#382). */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntime } from '../cli/runtime.js';
import {
  AppError,
  type BreakdownResponse,
  type LlmProvider,
  type ObjectRequest,
  type SectionBrief,
} from '../core/model/index.js';
import { PictureCache } from '../core/picture/cache.js';
import { ITEMS_PER_CALL } from '../core/picture/prompt.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import type { BreakdownService } from './breakdown.js';
import { createPictureService } from './pictures.js';
import { FAILED_RETRY_MS, type SummaryService } from './summary.js';

const DOC = 'e'.repeat(64);
const panel = {
  left: { glyphs: ['bank'] },
  link: 'to',
  carry: 'coins',
  right: { glyphs: ['person'] },
};

const brief = (n: number): SectionBrief => ({
  sectionId: `sec-${String(n)}`,
  text: `Part ${String(n)} gives money to people. [S:sec-${String(n)}]`,
  citations: [{ sectionId: `sec-${String(n)}`, valid: true, chunkIds: [] }],
  readingGrade: 6,
  example: 'available',
});
const briefs = (count: number): SectionBrief[] =>
  Array.from({ length: count }, (_, i) => brief(i + 1));

/** Draws every item it is sent, and records which item numbers each call carried. */
function drawingProvider(fail?: () => Error | undefined) {
  const calls: number[][] = [];
  const texts: string[][] = [];
  const provider: LlmProvider & { calls: number[][]; texts: string[][] } = {
    id: 'anthropic',
    model: 'claude-haiku-5-5',
    calls,
    texts,

    async *streamText() {
      await Promise.resolve();
      throw new Error('not scripted');
    },
    generateObject<T>(req: ObjectRequest<T>) {
      const error = fail?.();
      if (error) return Promise.reject(error);
      const items = [
        ...JSON.stringify(req.prompt).matchAll(/<item n=\\"(\d+)\\"/g),
      ].map((m) => Number(m[1]));
      calls.push(items);
      texts.push(
        [
          ...JSON.stringify(req.prompt).matchAll(
            /<item n=\\"\d+\\">([^<]*)<\/item>/g,
          ),
        ].map((m) => m[1] ?? ''),
      );
      return Promise.resolve({
        object: {
          pictures: items.map((item) => ({ item, panels: [panel] })),
        } as T,
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  };
  return provider;
}

const reported: string[] = [];
let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pictures-coverage-'));
  clock = 1_000_000;
  reported.length = 0;
  resetSharedLimits();
});
afterEach(async () => {
  resetSharedLimits();
  await rm(dir, { recursive: true, force: true });
});

function service(
  provider: LlmProvider,
  current: () => BreakdownResponse,
  progressive = true,
  listeners: ((docId: string) => void)[] = [],
  extra: {
    cache?: PictureCache;
    knownLimit?: number;
    registered?: () => boolean;
  } = {},
) {
  const runtime = {
    registry: {
      touch: vi.fn().mockResolvedValue(undefined),
      isRegistered: () => Promise.resolve(extra.registered?.() ?? true),
    },
    extractProvider: provider,
  } as unknown as CliRuntime;
  const summary: SummaryService = {
    get: () => Promise.resolve({ status: 'pending' }),
  };
  const breakdown: BreakdownService = {
    get: () => Promise.resolve(current()),
    example: () => Promise.reject(new Error('unused')),
    progressivePictures: progressive,
    reportPicturesStopped: (docId) => {
      reported.push(docId);
    },
    subscribe: (l) => {
      listeners.push(l);
    },
  };
  return createPictureService(runtime, {
    publicMode: false,
    summary,
    breakdown,
    now: () => clock,
    waitMs: 2000,
    cache: extra.cache ?? new PictureCache({ dir, now: () => clock }),
    knownLimit: extra.knownLimit,
  });
}

/** One look at a time, waiting for the group it started to land. */
async function settle(
  svc: ReturnType<typeof service>,
  until: (r: Awaited<ReturnType<typeof svc.get>>) => boolean,
) {
  let last = await svc.get(DOC, 'breakdown');
  for (let i = 0; i < 50 && !until(last); i++)
    last = await svc.get(DOC, 'breakdown');
  return last;
}

describe('breakdown pictures under full coverage', () => {
  it('draws only the groups that are full while the breakdown is unfinished', async () => {
    const provider = drawingProvider();
    const total = ITEMS_PER_CALL * 2 + 3;
    const svc = service(provider, () => ({
      status: 'partial',
      briefs: briefs(total),
    }));
    const r = await settle(
      svc,
      (x) => (x.entries?.length ?? 0) === ITEMS_PER_CALL * 2,
    );
    // Still pending: more briefs are coming. The 3 in the last group wait for the end.
    expect(r.status).toBe('pending');
    expect(r.entries).toHaveLength(ITEMS_PER_CALL * 2);
    expect(provider.calls.flat()).not.toContain(ITEMS_PER_CALL * 2);
    expect(provider.calls).toHaveLength(2);
  });

  it('never redraws a finished group when more briefs arrive', async () => {
    const provider = drawingProvider();
    let have = ITEMS_PER_CALL;
    let complete = false;
    const svc = service(provider, () =>
      complete
        ? { status: 'cached', briefs: briefs(have), omitted: 0 }
        : { status: 'partial', briefs: briefs(have) },
    );
    await settle(svc, (x) => (x.entries?.length ?? 0) === ITEMS_PER_CALL);
    expect(provider.calls).toHaveLength(1);

    have = ITEMS_PER_CALL * 2 + 4;
    await settle(svc, (x) => (x.entries?.length ?? 0) === ITEMS_PER_CALL * 2);
    expect(provider.calls).toHaveLength(2);

    complete = true;
    const done = await settle(svc, (x) => x.status === 'cached');
    expect(done.entries).toHaveLength(have);
    // Three groups drawn in all, each sent once with numbers local to the call.
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.map((c) => c.length)).toEqual([10, 10, 4]);
    expect(provider.calls[2]?.[0]).toBe(0);
    expect(done.entries?.map((e) => e.item)).toEqual(
      Array.from({ length: have }, (_, i) => i),
    );
  });

  it('draws one group per look, one at a time', async () => {
    const provider = drawingProvider();
    const svc = service(provider, () => ({
      status: 'cached',
      briefs: briefs(ITEMS_PER_CALL * 3),
      omitted: 0,
    }));
    const first = await svc.get(DOC, 'breakdown', { wait: false });
    expect(first.status).toBe('pending');
    await vi.waitFor(() => {
      expect(provider.calls).toHaveLength(1);
    });
    const done = await settle(svc, (x) => x.status === 'cached');
    expect(done.entries).toHaveLength(ITEMS_PER_CALL * 3);
  });

  it('without full coverage a partial breakdown draws nothing', async () => {
    const provider = drawingProvider();
    const svc = service(
      provider,
      () => ({ status: 'partial', briefs: briefs(ITEMS_PER_CALL * 2) }),
      false,
    );
    expect((await svc.get(DOC, 'breakdown')).status).toBe('none');
    expect(provider.calls).toHaveLength(0);
  });

  it('stops starting groups once the job budget is spent, and keeps what is drawn', async () => {
    // The budget runs out after the first batch has been drawn.
    let drawn = 0;
    const provider = drawingProvider(() => {
      if (drawn++ === 0) return undefined;
      const error = new AppError('RATE_LIMITED', 'budget');
      Object.defineProperty(error, 'code', { value: 'BUDGET_EXHAUSTED' });
      return error;
    });
    const svc = service(provider, () => ({
      status: 'cached',
      briefs: briefs(ITEMS_PER_CALL * 3),
      omitted: 0,
    }));
    // The next group hits the budget; after that no further group is started at all.
    const last = await settle(svc, (x) => x.status !== 'pending');
    expect(last.status).toBe('cached');
    expect(last.entries).toHaveLength(ITEMS_PER_CALL);
    expect(reported).toContain(DOC);
    const calls = provider.calls.length;
    await svc.get(DOC, 'breakdown', { wait: false });
    await svc.get(DOC, 'breakdown', { wait: false });
    expect(provider.calls).toHaveLength(calls);
  });

  it('draws every group in the background when a batch lands, with nobody polling', async () => {
    const provider = drawingProvider();
    let have = ITEMS_PER_CALL + 4;
    let complete = false;
    const listeners: ((docId: string) => void)[] = [];
    const svc = service(
      provider,
      () =>
        complete
          ? { status: 'cached', briefs: briefs(have), omitted: 0 }
          : { status: 'partial', briefs: briefs(have) },
      true,
      listeners,
    );
    const notify = () => {
      listeners.forEach((l) => {
        l(DOC);
      });
    };
    notify();
    await vi.waitFor(() => {
      expect(provider.calls).toHaveLength(1);
    });
    have = ITEMS_PER_CALL * 3 + 2;
    complete = true;
    notify();
    notify(); // an overlapping notice joins the running pass
    await vi.waitFor(() => {
      expect(provider.calls).toHaveLength(4);
    });
    // Everything is cached: a later poll is answered without drawing again.
    const done = await vi.waitFor(async () => {
      const r = await svc.get(DOC, 'breakdown', { wait: false });
      expect(r.status).toBe('cached');
      return r;
    });
    expect(done.entries).toHaveLength(have);
    expect(provider.calls).toHaveLength(4);
  });

  it('the background pass ends on a spent budget and starts nothing more', async () => {
    let spent = false;
    const provider = drawingProvider(() => {
      if (!spent) return undefined;
      const error = new AppError('RATE_LIMITED', 'budget');
      Object.defineProperty(error, 'code', { value: 'BUDGET_EXHAUSTED' });
      return error;
    });
    const listeners: ((docId: string) => void)[] = [];
    service(
      provider,
      () => ({
        status: 'cached',
        briefs: briefs(ITEMS_PER_CALL * 3),
        omitted: 0,
      }),
      true,
      listeners,
    );
    spent = true;
    listeners.forEach((l) => {
      l(DOC);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(provider.calls).toHaveLength(0);
    expect(reported).toEqual([DOC]);
    spent = false;
    listeners.forEach((l) => {
      l(DOC);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(provider.calls).toHaveLength(0);
  });

  it('repeated notices after a failure do not retry a cooling batch; it is retried after the cool-down', async () => {
    let attempts = 0;
    const provider = drawingProvider(() => {
      attempts++;
      return new AppError('PROVIDER_ERROR');
    });
    const listeners: ((docId: string) => void)[] = [];
    service(
      provider,
      () => ({ status: 'cached', briefs: briefs(ITEMS_PER_CALL), omitted: 0 }),
      true,
      listeners,
    );
    const notify = async () => {
      for (const l of listeners) l(DOC);
      await new Promise((r) => setTimeout(r, 40));
    };
    await notify();
    expect(attempts).toBe(1);
    await notify();
    await notify();
    expect(attempts).toBe(1);
    clock += FAILED_RETRY_MS + 1;
    await notify();
    expect(attempts).toBe(2);
  });

  it('a part that gets its brief late does not make finished pictures draw again (25 sections)', async () => {
    const provider = drawingProvider();
    const all = briefs(25);
    // First pass: sec-1 has no valid brief yet, so every later brief sits one place earlier.
    let current = all.slice(1);
    let complete = false;
    const listeners: ((docId: string) => void)[] = [];
    const svc = service(
      provider,
      () =>
        complete
          ? { status: 'cached', briefs: current, omitted: 0 }
          : { status: 'partial', briefs: current },
      true,
      listeners,
    );
    const notify = async () => {
      for (const l of listeners) l(DOC);
      await new Promise((r) => setTimeout(r, 60));
    };
    await notify();
    await vi.waitFor(() => {
      expect(provider.texts.flat()).toHaveLength(20);
    });
    // The resume brings sec-1 in at the front and finishes the rest.
    current = all;
    complete = true;
    await notify();
    await vi.waitFor(() => {
      expect(provider.texts.flat()).toHaveLength(25);
    });
    const drawnTexts = provider.texts.flat();
    // Each brief was sent exactly once: nothing already drawn was drawn again.
    expect(drawnTexts).toHaveLength(25);
    expect(new Set(drawnTexts).size).toBe(25);
    const done = await vi.waitFor(async () => {
      const r = await svc.get(DOC, 'breakdown', { wait: false });
      expect(r.status).toBe('cached');
      return r;
    });
    expect(done.entries?.map((e) => e.item)).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );
    expect(done.entries?.[0]?.sectionId).toBe('sec-1');
  });

  it('a poll and the background pass looking at the same time submit each brief once', async () => {
    const provider = drawingProvider();
    // Hold every cache read until both have looked, so both see the same briefs as missing.
    const real = new PictureCache({ dir, now: () => clock });
    let waiting = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const originalGet = real.get.bind(real);
    let paused = true;
    real.get = async (key) => {
      if (paused) {
        waiting++;
        await gate;
      }
      return originalGet(key);
    };
    const listeners: ((docId: string) => void)[] = [];
    const svc = service(
      provider,
      () => ({
        status: 'cached',
        briefs: briefs(ITEMS_PER_CALL),
        omitted: 0,
      }),
      true,
      listeners,
      { cache: real },
    );
    const polled = svc.get(DOC, 'breakdown', { wait: false });
    for (const l of listeners) l(DOC);
    await vi.waitFor(() => {
      expect(waiting).toBeGreaterThanOrEqual(2);
    });
    paused = false;
    open();
    await polled;
    await vi.waitFor(async () => {
      const r = await svc.get(DOC, 'breakdown', { wait: false });
      expect(r.status).toBe('cached');
    });
    expect(provider.texts.flat()).toHaveLength(ITEMS_PER_CALL);
    expect(provider.calls).toHaveLength(1);
  });

  it("remembers a bounded number of records, and forgets a removed document's", async () => {
    const provider = drawingProvider();
    let registered = true;
    const svc = service(
      provider,
      () => ({
        status: 'cached',
        briefs: briefs(ITEMS_PER_CALL * 2),
        omitted: 0,
      }),
      true,
      [],
      { knownLimit: 12, registered: () => registered },
    );
    await settle(svc, (x) => x.status === 'cached');
    expect(svc.knownRecords?.()).toBe(12);
    registered = false;
    await svc.get(DOC, 'breakdown', { wait: false });
    expect(svc.knownRecords?.()).toBe(0);
  });
});
