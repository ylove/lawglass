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
import type { SummaryService } from './summary.js';

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
  const provider: LlmProvider & { calls: number[][] } = {
    id: 'anthropic',
    model: 'claude-haiku-5-5',
    calls,

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

let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pictures-coverage-'));
  clock = 1_000_000;
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
) {
  const runtime = {
    registry: { touch: vi.fn().mockResolvedValue(undefined) },
    extractProvider: provider,
  } as unknown as CliRuntime;
  const summary: SummaryService = {
    get: () => Promise.resolve({ status: 'pending' }),
  };
  const breakdown: BreakdownService = {
    get: () => Promise.resolve(current()),
    example: () => Promise.reject(new Error('unused')),
    progressivePictures: progressive,
  };
  return createPictureService(runtime, {
    publicMode: false,
    summary,
    breakdown,
    now: () => clock,
    waitMs: 2000,
    cache: new PictureCache({ dir, now: () => clock }),
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
    // Three groups drawn in all: each item was sent once.
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls.flat().sort((a, b) => a - b)).toEqual(
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
    let spent = false;
    const provider = drawingProvider(() => {
      if (!spent) return undefined;
      const error = new AppError('RATE_LIMITED', 'budget');
      Object.defineProperty(error, 'code', { value: 'BUDGET_EXHAUSTED' });
      return error;
    });
    const svc = service(provider, () => ({
      status: 'cached',
      briefs: briefs(ITEMS_PER_CALL * 3),
      omitted: 0,
    }));
    await settle(svc, (x) => (x.entries?.length ?? 0) === ITEMS_PER_CALL);
    spent = true;
    // The next group hits the budget; after that no further group is started at all.
    const last = await settle(svc, (x) => x.status !== 'pending');
    expect(last.status).toBe('cached');
    expect(last.entries).toHaveLength(ITEMS_PER_CALL);
    const calls = provider.calls.length;
    await svc.get(DOC, 'breakdown', { wait: false });
    await svc.get(DOC, 'breakdown', { wait: false });
    expect(provider.calls).toHaveLength(calls);
  });
});
