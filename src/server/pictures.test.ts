import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptedObjects } from '../../tests/support/picture-provider.js';
import type { CliRuntime } from '../cli/runtime.js';
import {
  AppError,
  type AnswerResult,
  type BreakdownResponse,
  type LlmProvider,
  type SectionBrief,
  type SummaryResponse,
} from '../core/model/index.js';
import { PictureCache } from '../core/picture/cache.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import type { BreakdownService } from './breakdown.js';
import { createPictureService, type PictureLogEvent } from './pictures.js';
import { FAILED_RETRY_MS, type SummaryService } from './summary.js';

const DOC = 'b'.repeat(64);
const SUMMARY_TEXT = [
  'The Act sets up a system for payment stablecoins [S:sec-2].',
  '',
  '- Who can issue: banks and state-approved issuers [S:sec-4].',
  '- Stablecoins are not securities [S:sec-15].',
].join('\n');

const answer = (text: string): AnswerResult => ({
  text,
  citations: [],
  invalidCitations: [],
  warnings: [],
  declined: false,
  readingGrade: 7,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  usage: { inputTokens: 1, outputTokens: 1 },
});

const brief = (id: string, text: string): SectionBrief => ({
  sectionId: id,
  text,
  citations: [{ sectionId: id, valid: true, chunkIds: [] }],
  readingGrade: 6,
  example: 'none',
});

const issuePanel = {
  left: { glyphs: ['bank'] },
  link: 'to',
  carry: 'coins',
  right: { glyphs: ['person'] },
  stamp: { glyph: 'seal', label: 'State' },
};

let dir: string;
let clock: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pictures-service-'));
  clock = 1_000_000;
  resetSharedLimits();
});
afterEach(async () => {
  resetSharedLimits();
  await rm(dir, { recursive: true, force: true });
});

function service(opts: {
  provider?: LlmProvider | (() => LlmProvider);
  summary?: SummaryResponse | (() => Promise<SummaryResponse>);
  breakdown?: BreakdownResponse | (() => Promise<BreakdownResponse>);
  publicMode?: boolean;
}) {
  const events: PictureLogEvent[] = [];
  const runtime = {
    get extractProvider() {
      const p = opts.provider ?? scriptedObjects([{ pictures: [] }]);
      return typeof p === 'function' ? p() : p;
    },
  } as unknown as CliRuntime;
  const summary: SummaryService = {
    get: () =>
      typeof opts.summary === 'function'
        ? opts.summary()
        : Promise.resolve(opts.summary ?? { status: 'pending' }),
  };
  const breakdown: BreakdownService = {
    get: () =>
      typeof opts.breakdown === 'function'
        ? opts.breakdown()
        : Promise.resolve(opts.breakdown ?? { status: 'pending' }),
    example: () => Promise.reject(new Error('unused')),
  };
  const svc = createPictureService(runtime, {
    publicMode: opts.publicMode ?? false,
    summary,
    breakdown,
    now: () => clock,
    waitMs: 2000,
    log: (e) => events.push(e),
    cache: new PictureCache({ dir, now: () => clock }),
  });
  return { svc, events };
}

describe('summary pictures', () => {
  it('waits for the summary, then draws one run for its list items and caches it', async () => {
    const provider = scriptedObjects([
      { pictures: [{ item: 0, panels: [issuePanel] }] },
    ]);
    let summary: SummaryResponse = { status: 'pending' };
    const { svc, events } = service({
      provider,
      summary: () => Promise.resolve(summary),
    });
    expect(await svc.get(DOC, 'summary', { wait: false })).toEqual({
      status: 'pending',
    });
    expect(provider.calls).toHaveLength(0);

    summary = { status: 'cached', answer: answer(SUMMARY_TEXT) };
    expect((await svc.get(DOC, 'summary', { wait: false })).status).toBe(
      'pending',
    );
    const done = await svc.get(DOC, 'summary');
    expect(done.status).toBe('cached');
    expect(done.entries).toEqual([
      {
        item: 0,
        text: '- Who can issue: banks and state-approved issuers [S:sec-4].'.slice(
          2,
        ),
        panels: [issuePanel],
      },
    ]);
    // Only the list items were sent, never the intro paragraph.
    expect(provider.calls[0]?.prompt).not.toContain('payment stablecoins');
    expect(provider.calls[0]?.prompt).toContain('not securities');
    expect(events).toEqual([
      { event: 'pictures_made', source: 'summary', count: 1 },
    ]);
    // A later look is a cache hit: no second call.
    expect((await svc.get(DOC, 'summary')).status).toBe('cached');
    expect(provider.calls).toHaveLength(1);
  });

  it('a summary without a list, or a disabled one, has nothing to draw', async () => {
    const prose = service({
      summary: { status: 'cached', answer: answer('Just prose [S:sec-1].') },
    });
    expect(await prose.svc.get(DOC, 'summary')).toEqual({ status: 'none' });
    const off = service({ summary: { status: 'disabled' } });
    expect(await off.svc.get(DOC, 'summary')).toEqual({ status: 'none' });
  });

  it('nothing drawable is cached as none, and logged with the refused count', async () => {
    const provider = scriptedObjects([
      {
        pictures: [
          {
            item: 1,
            panels: [
              { ...issuePanel, stamp: { glyph: 'seal', label: 'Unsafe' } },
            ],
          },
        ],
      },
    ]);
    const { svc, events } = service({
      provider,
      summary: { status: 'cached', answer: answer(SUMMARY_TEXT) },
    });
    await svc.get(DOC, 'summary', { wait: false });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'none' });
    expect(events).toContainEqual({
      event: 'pictures_dropped',
      source: 'summary',
      count: 1,
    });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'none' });
    expect(provider.calls).toHaveLength(1);
  });

  it('a failed run reads as none and is not repeated until the cool-down has passed', async () => {
    const provider = scriptedObjects([new AppError('PROVIDER_ERROR')]);
    const onError = vi.fn();
    const { svc } = service({
      provider,
      summary: { status: 'cached', answer: answer(SUMMARY_TEXT) },
    });
    await svc.get(DOC, 'summary', { wait: false, onError });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'none' });
    expect(provider.calls).toHaveLength(1);
    clock += FAILED_RETRY_MS;
    expect((await svc.get(DOC, 'summary', { wait: false })).status).toBe(
      'pending',
    );
    await vi.waitFor(() => {
      expect(provider.calls).toHaveLength(2);
    });
  });

  it('public mode serves cache hits only and never calls the model', async () => {
    const provider = scriptedObjects([{ pictures: [] }]);
    const { svc } = service({
      provider,
      publicMode: true,
      summary: { status: 'cached', answer: answer(SUMMARY_TEXT) },
    });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'disabled' });
    expect(provider.calls).toHaveLength(0);
  });

  it('no provider configured means disabled, not an error', async () => {
    const { svc } = service({
      provider: () => {
        throw new AppError('MISSING_KEY');
      },
      summary: { status: 'cached', answer: answer(SUMMARY_TEXT) },
    });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'disabled' });
  });
});

describe('never a reason to make the source text', () => {
  it('asks the summary and breakdown to report only, and never to start a run', async () => {
    const seen: unknown[] = [];
    const runtime = {
      extractProvider: scriptedObjects([{ pictures: [] }]),
    } as unknown as CliRuntime;
    const svc = createPictureService(runtime, {
      publicMode: false,
      summary: {
        get: (_id, request) => {
          seen.push(request);
          return Promise.resolve({ status: 'disabled' });
        },
      },
      breakdown: {
        get: (_id, request) => {
          seen.push(request);
          return Promise.resolve({ status: 'disabled' });
        },
        example: () => Promise.reject(new Error('unused')),
      },
      cache: new PictureCache({ dir }),
    });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'none' });
    expect(await svc.get(DOC, 'breakdown')).toEqual({ status: 'none' });
    expect(seen).toEqual([
      { wait: false, start: false },
      { wait: false, start: false },
    ]);
  });

  it('a summary that throws (an unconfigured answer provider) reads as none', async () => {
    const { svc } = service({
      summary: () => Promise.reject(new AppError('MISSING_KEY')),
    });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'none' });
  });

  it('an item too long for the contract stays text-only instead of being redrawn on every look', async () => {
    const provider = scriptedObjects([{ pictures: [] }]);
    const { svc } = service({
      provider,
      summary: {
        status: 'cached',
        answer: answer(`- ${'word '.repeat(900)}[S:sec-1].`),
      },
    });
    expect(await svc.get(DOC, 'summary')).toEqual({ status: 'none' });
    expect(provider.calls).toHaveLength(0);
  });
});

describe('breakdown pictures', () => {
  it('draws one picture per brief, tied to its part and its exact text', async () => {
    const briefs = [
      brief('sec-4', 'Banks may issue coins with state approval. [S:sec-4]'),
      brief('sec-5', 'Holders get no interest. [S:sec-5]'),
    ];
    const provider = scriptedObjects([
      { pictures: [{ item: 0, panels: [issuePanel] }] },
    ]);
    const { svc } = service({
      provider,
      breakdown: { status: 'cached', briefs, omitted: 0 },
    });
    await svc.get(DOC, 'breakdown', { wait: false });
    const done = await svc.get(DOC, 'breakdown');
    expect(done.entries).toEqual([
      {
        item: 0,
        text: briefs[0]?.text,
        sectionId: 'sec-4',
        panels: [issuePanel],
      },
    ]);
  });

  it('a pending, empty or cooling-down breakdown has nothing to draw yet', async () => {
    expect(
      await service({ breakdown: { status: 'pending' } }).svc.get(
        DOC,
        'breakdown',
      ),
    ).toEqual({ status: 'pending' });
    expect(
      await service({
        breakdown: { status: 'cached', briefs: [], omitted: 0 },
      }).svc.get(DOC, 'breakdown'),
    ).toEqual({ status: 'none' });
    expect(
      await service({
        breakdown: () => Promise.reject(new AppError('PROVIDER_ERROR')),
      }).svc.get(DOC, 'breakdown'),
    ).toEqual({ status: 'none' });
  });
});
