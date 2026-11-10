/**
 * Cost calibration (#385): runs the real pipeline over a plan of bills and compares what the
 * model providers actually billed with what the estimator in `src/core/cost` forecast.
 *
 *   tsx scripts/calibrate.ts [--max-usd 10] [--max-usd-per-bill 3] [--plan plan.json] [--dry-run]
 *
 * It runs the server in-process (`createRuntime` + `createApp`, driven through `app.request`)
 * with the hosting hooks a paying host would use: `admission` gives every job a dollar budget,
 * `onUsage` records every call, and `backgroundScope` keeps each document's budget in memory.
 * Nothing is bound to a port, so no key or bill text leaves this process except to the provider.
 *
 * Spending is capped three ways, because a cap that fails open costs real money:
 *   1. every admitted job carries a dollar budget of at most what is left of the run and total
 *      caps;
 *   2. every provider call first reserves its worst case (prompt at the dearest rate plus all
 *      `maxTokens` of output) and is refused unless that fits under the caps together with the
 *      calls already in flight, so parallel calls cannot overshoot (a stand-in for the spend
 *      gate of #397, which is not in this tree);
 *   3. each run has its own books and is closed when it ends: its late usage stays with it, and
 *      it can start no new call. The job waits up to a minute for calls in flight at the end.
 *
 * The report goes to stdout as one line starting `CALIBRATION REPORT ` (the prefix keeps it in
 * Cloud Logging's textPayload), after a `CALIBRATION RUN ` line per finished run, and also to
 * `CALIBRATION_OUT` when that is a file path. A `gs://` URL is
 * not written: `@google-cloud/storage` is not a dependency, so the job logs are the output.
 * Progress goes to stderr. The API key is read by the provider alone and is never printed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { Context } from 'hono';
import { createApp } from '../src/server/index.js';
import { createRuntime, type CliRuntime } from '../src/cli/runtime.js';
import {
  billFacts,
  PRICES,
  callDollars,
  estimateBill,
  modelPrice,
  type CallTokens,
  type ModelPrice,
  type BillEstimate,
  type PriceTable,
  type UsageEvent,
} from '../src/core/cost/index.js';
import { jsonSchema } from '../src/core/llm/shared.js';
import { MockProvider } from '../src/core/llm/mock.js';
import {
  AppError,
  AskEvent,
  BreakdownResponse,
  DECLINE_TEXT,
  IngestEvent,
  PicturesResponse,
  ScenarioResponse,
  SummaryResponse,
  type AnswerResult,
  type LlmProvider,
  type SectionBrief,
} from '../src/core/model/index.js';
import { readSseEvents } from '../src/web/sse.js';
import {
  FEATURES,
  CalibrationReport,
  type Feature,
  type Quality,
  type Run,
  type Tokens,
} from './calibration-schema.js';

// --- the plan ---------------------------------------------------------------------------------

export const PlanRun = z.object({
  bill: z.string().min(1),
  url: z.url(),
  /** A short name for the model assignment, e.g. `haiku` or `sonnet+haiku`. */
  plan: z.string().min(1),
  answerModel: z.string().min(1),
  extractModel: z.string().min(1),
  breakdownMaxUnits: z.union([z.number().int().positive(), z.literal('all')]),
  pregenerateExamples: z.enum(['all', 'small', 'off']),
  /** Minutes allowed after the ingest; default is the job's `--run-timeout-minutes`. */
  timeoutMinutes: z.number().positive().optional(),
});
export type PlanRun = z.infer<typeof PlanRun>;

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

/** The URLs are the forms each resolver accepts (checked in calibrate.test.ts). */
export const BILLS = {
  'S. 1582': 'https://www.congress.gov/bill/119th-congress/senate-bill/1582',
  'S. 5687': 'https://www.congress.gov/bill/118th-congress/senate-bill/5687',
  'NY A. 5000': 'https://www.nysenate.gov/legislation/bills/2025/A5000',
  'NJ S. 1000': 'https://www.njleg.state.nj.us/bill-search/2024/S1000',
  'Ohio S.B. 113': 'https://www.legislature.ohio.gov/legislation/136/sb113',
  'H.R. 5009 (NDAA)':
    'https://www.congress.gov/bill/118th-congress/house-bill/5009',
} as const;

/**
 * Order matters when the cap binds: the cheap Haiku runs first, then the NDAA (capped at 30
 * parts, to scale per part), then the dearer Sonnet runs.
 */
export function defaultPlan(): PlanRun[] {
  const small = Object.entries(BILLS).filter(
    ([name]) => !name.includes('NDAA'),
  );
  const full = {
    breakdownMaxUnits: 'all',
    pregenerateExamples: 'all',
  } as const;
  const haiku = (bill: string, url: string): PlanRun => ({
    bill,
    url,
    plan: 'haiku',
    answerModel: HAIKU,
    extractModel: HAIKU,
    ...full,
  });
  return [
    ...small.map(([bill, url]) => haiku(bill, url)),
    {
      ...haiku('H.R. 5009 (NDAA)', BILLS['H.R. 5009 (NDAA)']),
      breakdownMaxUnits: 30,
      pregenerateExamples: 'small',
      // Its ingest alone takes about eight minutes on the job's size; this starts after it.
      timeoutMinutes: 25,
    },
    ...small.map(([bill, url]): PlanRun => ({
      bill,
      url,
      plan: 'sonnet+haiku',
      answerModel: SONNET,
      extractModel: HAIKU,
      ...full,
    })),
  ];
}

/** Two fixed questions, so runs differ only in the model and the bill. */
export const QUESTIONS = [
  'Who would be affected by this bill, and how?',
  'What penalties or enforcement does this bill provide, if any?',
] as const;

// --- options ----------------------------------------------------------------------------------

export interface CalibrationOptions {
  runtime: CliRuntime;
  plan: readonly PlanRun[];
  /** Total cap in dollars across every run. */
  maxUsd: number;
  /** Cap in dollars for one run (one bill on one model plan). */
  maxUsdPerRun: number;
  dryRun?: boolean;
  /** Rates for models outside the built-in table. */
  prices?: PriceTable;
  /** Do not start a run with less than this left under the total cap. Default $0.05. */
  minRunUsd?: number;
  pollMs?: number;
  /** A run waits this long without a new model call before it counts as settled. */
  idleMs?: number;
  /** Stop starting runs after this time (epoch ms), and cut a running one short at it. */
  deadlineAt?: number;
  /** Called with each run as it finishes, so a job that is killed keeps what it measured. */
  onRun?: (run: Run) => void;
  /** Give up on one run after this long. */
  runTimeoutMs?: number;
  log?: (line: string) => void;
}

/** A question gets this much of the budget at most, so a runaway answer cannot eat a run. */
const QUESTION_BUDGET_USD = 0.75;
/** Below this the next run is not worth starting. */
const MIN_RUN_USD = 0.05;
/** How long to wait for calls in flight to report after a run or the whole job ends: the provider's own timeout plus a margin. */
const SETTLE_MS = 150_000;

// --- accounting -------------------------------------------------------------------------------

interface Priced {
  feature: Feature | 'question' | 'other';
  model: string;
  tokens: Tokens;
  estimated: boolean;
  unpriced: boolean;
}

const ZERO: Tokens = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  dollars: 0,
};
const add = (a: Tokens, b: Tokens): Tokens => ({
  calls: a.calls + b.calls,
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  dollars: a.dollars + b.dollars,
});
const ratio = (measured: number, bound: number): number | null =>
  bound > 0 ? measured / bound : null;

/** Which forecast line a usage event belongs to. */
function featureOf(event: UsageEvent): Priced['feature'] {
  switch (event.feature) {
    case 'metadata':
    case 'summary':
    case 'breakdown':
    case 'pictures':
    case 'examples':
      return event.feature;
    case 'scenario':
      // The bill's story is forecast; the story that follows a question is not.
      return event.job?.jobKind === 'question' ? 'other' : 'summaryScenario';
    case 'question':
      return 'question';
    default:
      return 'other';
  }
}

/** Priced with the same table the budgets use. An unknown model is charged at the dearest built-in rate. */
function price(event: UsageEvent, prices: PriceTable): Priced {
  const counts = {
    inputTokens: event.usage.inputTokens,
    cachedInputTokens: event.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
    outputTokens: event.usage.outputTokens,
  };
  let unpriced = false;
  let dollars: number;
  try {
    dollars = callDollars(counts, modelPrice(event.model, prices));
  } catch {
    unpriced = true;
    dollars = dearestDollars(counts);
  }
  return {
    feature: featureOf(event),
    model: event.model,
    tokens: { calls: 1, ...counts, dollars },
    estimated: event.estimated === true,
    unpriced,
  };
}

/** What a call would cost on the dearest model in the built-in table. */
function dearestDollars(counts: CallTokens): number {
  return Math.max(
    ...Object.values(PRICES).map((rate) => callDollars(counts, rate)),
  );
}

/**
 * The most a call can cost: the prompt (over-counted at 3 characters a token, as if every
 * token were written to the cache) plus every output token it may produce. An unknown model is
 * priced at the dearest built-in rate.
 */
export function worstCallDollars(
  model: string,
  req: { maxTokens: number; system: string } & (
    { messages: unknown } | { prompt: unknown }
  ) & { schema?: z.ZodType },
  prices: PriceTable = {},
): number {
  // Two bytes a token is far denser than any real tokenizer, so this over-counts. A structured
  // call also sends its JSON schema.
  const sent = JSON.stringify([
    req.system,
    'messages' in req ? req.messages : req.prompt,
    req.schema ? jsonSchema(req.schema) : null,
  ]);
  const input = Math.ceil(Buffer.byteLength(sent, 'utf8') / 2);
  const counts = (cacheWrite: number): CallTokens => ({
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteTokens: cacheWrite,
    outputTokens: req.maxTokens,
  });
  /** The base rates and, when the model has them, the long-context rates for the whole call. */
  const rates = (rate: ModelPrice): ModelPrice[] =>
    rate.longContext
      ? [rate, { ...rate, ...rate.longContext, longContext: undefined }]
      : [rate];
  const worst = (all: readonly ModelPrice[]): number =>
    Math.max(
      ...all.flatMap((rate) =>
        rates(rate).flatMap((r) => [
          callDollars(counts(0), r),
          callDollars(counts(input), r),
        ]),
      ),
    );
  try {
    return worst([modelPrice(model, prices)]);
  } catch {
    return worst(Object.values(PRICES));
  }
}

const sumOf = (rows: readonly Priced[]): Tokens =>
  rows.reduce((n, r) => add(n, r.tokens), ZERO);

function quality(
  items: readonly {
    citations: readonly { valid: boolean }[];
    declined: boolean;
    warned: boolean;
  }[],
): Quality {
  const citations = items.reduce((n, i) => n + i.citations.length, 0);
  const validCitations = items.reduce(
    (n, i) => n + i.citations.filter((c) => c.valid).length,
    0,
  );
  return {
    items: items.length,
    citations,
    validCitations,
    validityRate: citations === 0 ? null : validCitations / citations,
    declines: items.filter((i) => i.declined).length,
    warned: items.filter((i) => i.warned).length,
  };
}
const fromAnswer = (a: AnswerResult) => ({
  citations: a.citations,
  declined: a.declined,
  warned: a.warnings.length > 0,
});
const fromBrief = (b: SectionBrief) => ({
  citations: b.citations,
  declined: b.text.trim() === '' || b.text.includes(DECLINE_TEXT),
  warned: false,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- the run ----------------------------------------------------------------------------------

export async function runCalibration(
  options: CalibrationOptions,
): Promise<CalibrationReport> {
  const log = options.log ?? (() => undefined);
  const pollMs = options.pollMs ?? 3000;
  const idleMs = options.idleMs ?? 20_000;
  const runTimeoutMs = options.runTimeoutMs ?? 45 * 60_000;
  const prices = options.prices ?? {};

  let total = 0; // dollars reported by finished calls, across every run
  let reserved = 0; // worst-case dollars of calls in flight, across every run
  let inflight = 0;
  // Set when a call or job was refused because of the TOTAL cap: nothing further may start.
  let capHit = false;
  const halted = (): boolean => capHit || total >= options.maxUsd;

  /** One run's own books: late usage from its calls stays with it, and it can be closed. */
  interface RunState {
    open: boolean;
    events: Priced[];
    spent: number;
    reserved: number;
    inflight: number;
    lastUsageAt: number;
  }
  const newState = (): RunState => ({
    open: true,
    events: [],
    spent: 0,
    reserved: 0,
    inflight: 0,
    lastUsageAt: Date.now(),
  });
  const cap = (s: RunState): number =>
    Math.min(options.maxUsd - total, options.maxUsdPerRun - s.spent);
  const runSpent = (s: RunState): boolean => s.spent >= options.maxUsdPerRun;

  const usageSink = (s: RunState) => (event: UsageEvent) => {
    const priced = price(event, prices);
    total += priced.tokens.dollars;
    s.spent += priced.tokens.dollars;
    s.lastUsageAt = Date.now();
    s.events.push(priced);
  };

  /**
   * Refuses a call unless its WORST case still fits under both caps with everything already in
   * flight, so parallel calls cannot jointly overshoot. The reservation is released after the
   * caller has had a chance to report the real usage, which then counts in `total` instead.
   */
  const guardFor =
    (s: RunState) =>
    (p: LlmProvider): LlmProvider => {
      const admit = async (
        req: Parameters<typeof worstCallDollars>[1],
      ): Promise<number> => {
        const worst = worstCallDollars(p.model, req, prices);
        for (;;) {
          if (!s.open || capHit) throw new AppError('BUDGET_EXHAUSTED');
          // A call that cannot fit even alone ends the job's spending for good.
          if (total + worst > options.maxUsd) {
            capHit = true;
            throw new AppError('BUDGET_EXHAUSTED');
          }
          if (s.spent + worst > options.maxUsdPerRun)
            throw new AppError('BUDGET_EXHAUSTED');
          // It fits alone but not beside the calls in flight: wait for them to report.
          if (
            total + reserved + worst <= options.maxUsd &&
            s.spent + s.reserved + worst <= options.maxUsdPerRun
          )
            break;
          await sleep(10);
        }
        reserved += worst;
        s.reserved += worst;
        inflight++;
        s.inflight++;
        return worst;
      };
      const release = (worst: number): void => {
        // After the metering wrapper's continuation, which records the actual cost.
        setTimeout(() => {
          reserved -= worst;
          s.reserved -= worst;
          inflight--;
          s.inflight--;
        }, 0);
      };
      return {
        get id() {
          return p.id;
        },
        get model() {
          return p.model;
        },
        streamText: async function* (req) {
          const worst = await admit(req);
          try {
            yield* p.streamText(req);
          } finally {
            release(worst);
          }
        },
        generateObject: async (req) => {
          const worst = await admit(req);
          try {
            return await p.generateObject(req);
          } finally {
            release(worst);
          }
        },
      };
    };
  const runtimeFor = (s: RunState): CliRuntime => {
    const guard = guardFor(s);
    return Object.create(options.runtime, {
      answerProvider: {
        get: () => guard(options.runtime.answerProvider),
        enumerable: true,
      },
      extractProvider: {
        get: () => guard(options.runtime.extractProvider),
        enumerable: true,
      },
      providerFor: {
        value: (role: 'answer' | 'extract', model?: string) =>
          guard(options.runtime.providerFor(role, model)),
        enumerable: true,
      },
    }) as CliRuntime;
  };
  /** Waits for calls still in flight to report, up to a minute. */
  const settled = async (get: () => number): Promise<void> => {
    const until = Date.now() + SETTLE_MS;
    while (get() > 0 && Date.now() < until) await sleep(10);
  };

  const report: CalibrationReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun ?? false,
    caps: { maxUsd: options.maxUsd, maxUsdPerRun: options.maxUsdPerRun },
    spentUsd: 0,
    capReached: false,
    skipped: [],
    runs: [],
  };

  for (const [index, planRun] of options.plan.entries()) {
    const outOfTime =
      options.deadlineAt !== undefined && Date.now() >= options.deadlineAt;
    if (
      outOfTime ||
      halted() ||
      options.maxUsd - total < (options.minRunUsd ?? MIN_RUN_USD)
    ) {
      report.capReached ||= !outOfTime;
      for (const rest of options.plan.slice(index))
        report.skipped.push({
          bill: rest.bill,
          plan: rest.plan,
          reason: outOfTime
            ? 'the job deadline passed'
            : `total cap of $${String(options.maxUsd)} reached ($${total.toFixed(4)} spent)`,
        });
      break;
    }
    const started = Date.now();
    log(
      `run ${String(index + 1)}/${String(options.plan.length)}: ${planRun.bill} on ${planRun.plan}`,
    );
    const run = await executeRun(planRun);
    run.elapsedSeconds = (Date.now() - started) / 1000;
    report.runs.push(run);
    options.onRun?.(run);
    report.spentUsd = total;
    log(
      `  ${run.status}, $${run.spentUsd.toFixed(4)} (total $${total.toFixed(4)})${run.note ? `: ${run.note}` : ''}`,
    );
  }
  // Nothing may start now, and what is still in flight must report before the totals are final.
  await settled(() => inflight);
  report.spentUsd = total;
  report.capReached ||= halted();
  return CalibrationReport.parse(report);

  async function executeRun(planRun: PlanRun): Promise<Run> {
    const models = {
      answer: planRun.answerModel,
      extract: planRun.extractModel,
    };
    const scopes = new Map<
      string,
      { budget: { dollars: number }; jobId: string }
    >();
    const state = newState();
    const app = createApp(runtimeFor(state), {
      auth: { middleware: (_c, next) => next(), readerId: () => 'calibration' },
      logWriter: () => undefined,
      breakdownMaxUnits: planRun.breakdownMaxUnits,
      pregenerateExamples: planRun.pregenerateExamples,
      onUsage: usageSink(state),
      modelFor: () => models,
      quote: {
        tiers: {
          [planRun.plan]: {
            answerModel: planRun.answerModel,
            extractModel: planRun.extractModel,
          },
        },
        prices,
        perHour: 1000,
        perReaderPerHour: 1000,
        plan: { pregenerateExamples: planRun.pregenerateExamples },
      },
      admission: (_c: Context, job) => {
        const left = cap(state);
        if (halted() || left <= 0)
          return Promise.resolve({
            allow: false,
            status: 403,
            error: {
              code: 'BUDGET_EXHAUSTED',
              message: 'The calibration cap is reached.',
            },
          });
        const dollars =
          job.kind === 'ingest' ? left : Math.min(left, QUESTION_BUDGET_USD);
        if (job.kind === 'ingest' && job.docId)
          scopes.set(`${job.docId}\n${job.tier ?? ''}`, {
            budget: { dollars },
            jobId: `calibration-${job.docId.slice(0, 8)}`,
          });
        return Promise.resolve({ allow: true, budget: { dollars } });
      },
      // Background work for a document keeps what is LEFT of the run, not the admission's figure.
      backgroundScope: (docId, tier, scopeModels) => {
        const saved = scopes.get(`${docId}\n${tier}`);
        if (!saved) return Promise.resolve(undefined);
        return Promise.resolve({
          budget: { dollars: Math.max(0, cap(state)) },
          jobId: saved.jobId,
          ...(scopeModels ? { models: scopeModels } : {}),
        });
      },
    });

    const call = (
      path: string,
      init: { body?: unknown } = {},
    ): Promise<Response> =>
      Promise.resolve(
        app.request(path, {
          method: init.body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json' },
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        }),
      );
    /** A parsed body, or the error code when the route refused (a spent budget, a cool-down). */
    const getJson = async <T>(
      path: string,
      schema: { parse: (v: unknown) => T },
    ): Promise<{ ok: T } | { error: string }> => {
      const res = await call(path);
      const body: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        const code = (body as { error?: { code?: string } } | undefined)?.error
          ?.code;
        return { error: code ?? `HTTP ${String(res.status)}` };
      }
      return { ok: schema.parse(body) };
    };

    const run: Run = emptyRun(planRun, {
      maxUsd: options.maxUsd,
      maxUsdPerRun: options.maxUsdPerRun,
    });
    const notes: string[] = [];
    let status: Run['status'] = 'completed';
    // The clock starts after the ingest: embedding a long bill can take most of ten minutes
    // and is not what is being measured. Until then only the job deadline applies.
    const runTimeout = (planRun.timeoutMinutes ?? 0) * 60_000 || runTimeoutMs;
    let deadline = options.deadlineAt ?? Infinity;
    const timedOut = (): boolean => Date.now() > deadline;
    /** Waits until no model call has been reported for `idleMs`, or the deadline. */
    const drain = async (): Promise<void> => {
      while (!timedOut() && Date.now() - state.lastUsageAt < idleMs)
        await sleep(Math.min(pollMs, idleMs));
    };

    let briefs: SectionBrief[] = [];
    let omitted = 0;
    let summaryAnswer: AnswerResult | undefined;
    let examplesDone: number | null = null;
    const answers: AnswerResult[] = [];
    let estimate: BillEstimate | undefined;
    try {
      // 1. Quote: sizes the bill and prices it, with no model call.
      const quoted = await call('/api/quote', { body: { url: planRun.url } });
      if (!quoted.ok)
        throw new Error(`quote refused (HTTP ${String(quoted.status)})`);
      const quote = (await quoted.json()) as {
        estimates: Record<string, BillEstimate>;
      };
      run.quote = Object.fromEntries(
        Object.entries(quote.estimates).map(([tier, e]) => [
          tier,
          { low: e.total.low.dollars, high: e.total.high.dollars },
        ]),
      );

      // 2. Ingest.
      const ingest = await call('/api/ingest', { body: { url: planRun.url } });
      if (!ingest.ok)
        throw new Error(`ingest refused (HTTP ${String(ingest.status)})`);
      let docId: string | undefined;
      for await (const e of readSseEvents(ingest, IngestEvent)) {
        if (e.type === 'done') docId = e.doc.docId;
        if (e.type === 'error')
          throw new Error(`ingest failed: ${e.error.code}`);
      }
      if (!docId) throw new Error('the ingest did not finish');
      run.docId = docId;
      deadline = Math.min(
        Date.now() + runTimeout,
        options.deadlineAt ?? Infinity,
      );

      // The forecast for what this run will do: the same caps the server runs with.
      const doc = await options.runtime.registry.getDocument(docId);
      const facts = billFacts(doc.sections, {
        breakdownUnitCap: planRun.breakdownMaxUnits,
      });
      const uncapped = billFacts(doc.sections, { breakdownUnitCap: 'all' });
      run.facts = {
        pages: doc.pageCount ?? null,
        sections: facts.sectionCount,
        tokens: facts.estimatedTokens,
        mode: facts.mode,
        units: facts.breakdownUnits,
        unitsUncapped: uncapped.breakdownUnits,
      };
      estimate = estimateBill(
        facts,
        {
          answerModel: planRun.answerModel,
          extractModel: planRun.extractModel,
          pregenerateExamples: planRun.pregenerateExamples,
        },
        prices,
      );

      // 3. Summary, breakdown and pictures, asked for until each is finished or stopped.
      const base = `/api/docs/${docId}`;
      let stopNote: string | undefined;
      for (;;) {
        if (halted()) {
          stopNote = `total cap reached ($${total.toFixed(2)})`;
          break;
        }
        if (runSpent(state)) {
          stopNote = `per-run cap reached ($${state.spent.toFixed(2)})`;
          break;
        }
        if (timedOut()) {
          status = 'timeout';
          stopNote = `not finished after ${String(Math.round(runTimeoutMs / 60_000))} minutes`;
          break;
        }
        const [s, b, ps, pb] = await Promise.all([
          getJson(`${base}/summary`, SummaryResponse),
          getJson(`${base}/breakdown`, BreakdownResponse),
          getJson(`${base}/summary/pictures`, PicturesResponse),
          getJson(`${base}/breakdown/pictures`, PicturesResponse),
        ]);
        const refused = [s, b, ps, pb].find((r) => 'error' in r);
        if (refused && 'error' in refused) {
          stopNote = `a route refused: ${refused.error}`;
          break;
        }
        const [sOk, bOk, psOk, pbOk] = [s, b, ps, pb].map((r) =>
          'ok' in r ? r.ok : undefined,
        );
        const breakdown = bOk as z.infer<typeof BreakdownResponse>;
        summaryAnswer =
          (sOk as z.infer<typeof SummaryResponse>).answer ?? summaryAnswer;
        briefs = breakdown.briefs ?? briefs;
        omitted = breakdown.omitted ?? omitted;
        const stopped =
          breakdown.stoppedReason ?? breakdown.progress?.stoppedReason;
        const pending = (r: unknown): boolean =>
          (r as { status: string }).status === 'pending';
        const bdDone =
          breakdown.status !== 'pending' && breakdown.status !== 'partial';
        if (stopped) {
          stopNote = `breakdown stopped: ${stopped}`;
          break;
        }
        if (!pending(sOk) && bdDone && !pending(psOk) && !pending(pbOk)) break;
        await sleep(pollMs);
      }
      if (stopNote) notes.push(stopNote);

      // Pictures that matched a brief's own text, and examples (asked one by one when the policy
      // pre-draws all of them, so the coverage is measured, not assumed).
      const eligible = briefs.filter((b) => b.example === 'available');
      const pictures = await getJson(
        `${base}/breakdown/pictures`,
        PicturesResponse,
      );
      const drawn = new Set(
        ('ok' in pictures ? (pictures.ok.entries ?? []) : []).map(
          (e) => `${e.sectionId ?? ''}\n${e.text}`,
        ),
      );
      const pictured = eligible.filter((b) =>
        drawn.has(`${b.sectionId}\n${b.text}`),
      ).length;
      if (planRun.pregenerateExamples === 'all' && !stopNote) {
        let ok = 0;
        for (const b of eligible) {
          const path = `${base}/sections/${encodeURIComponent(b.sectionId)}/example`;
          for (;;) {
            if (halted() || runSpent(state) || timedOut()) break;
            const r = await getJson(path, ScenarioResponse);
            if ('error' in r) break;
            if (r.ok.status === 'pending') {
              await sleep(pollMs);
              continue;
            }
            if (r.ok.status === 'ok') ok++;
            break;
          }
          if (halted() || runSpent(state) || timedOut()) {
            notes.push('examples not finished before a cap or the deadline');
            break;
          }
        }
        examplesDone = ok;
      }
      await drain();

      // 4. Two fixed questions.
      if (!halted() && !runSpent(state)) {
        for (const question of QUESTIONS) {
          const res = await call(`${base}/ask`, { body: { question } });
          if (!res.ok) {
            notes.push(`a question was refused (HTTP ${String(res.status)})`);
            continue;
          }
          for await (const e of readSseEvents(res, AskEvent)) {
            if (e.type === 'done') answers.push(e.answer);
            if (e.type === 'error')
              notes.push(`a question failed: ${e.error.code}`);
          }
        }
        await drain();
      } else notes.push('questions skipped: a cap was reached');

      run.coverage = {
        briefs: briefs.length,
        omitted,
        eligible: eligible.length,
        pictures: pictured,
        examples: examplesDone,
      };
      if (stopNote && status === 'completed') status = 'stopped';
    } catch (error) {
      status = 'failed';
      notes.push(error instanceof Error ? error.message : 'unknown error');
    }

    // Close the run: its calls still in flight report into it, and none can start after this.
    state.open = false;
    await settled(() => state.inflight);
    run.spentUsd = state.spent;
    const events = state.events;
    const bySection = (f: Priced['feature']): Priced[] =>
      events.filter((e) => e.feature === f);
    const zeroEstimate = { low: ZERO, high: ZERO };
    for (const f of FEATURES) {
      const forecast = estimate?.features[f];
      const rows = bySection(f);
      const measured = sumOf(rows);
      const high = forecast?.high ?? ZERO;
      run.features[f] = {
        model: forecast?.model ?? '',
        estimate: forecast
          ? { low: forecast.low, high: forecast.high }
          : zeroEstimate,
        measured: {
          ...measured,
          estimatedCalls: rows.filter((r) => r.estimated).length,
          unpricedCalls: rows.filter((r) => r.unpriced).length,
        },
        ratioHigh: ratio(measured.dollars, high.dollars),
        ratioHighInput: ratio(measured.inputTokens, high.inputTokens),
        ratioHighOutput: ratio(measured.outputTokens, high.outputTokens),
      };
    }
    const questionRows = bySection('question');
    const questionMeasured = sumOf(questionRows);
    const questionEstimate = estimate?.question ?? { low: ZERO, high: ZERO };
    run.questions = {
      asked: answers.length,
      estimate: { low: questionEstimate.low, high: questionEstimate.high },
      measured: questionMeasured,
      ratioHigh: ratio(
        questionMeasured.dollars / Math.max(1, answers.length),
        questionEstimate.high.dollars,
      ),
    };
    run.other = sumOf(bySection('other'));
    const measuredTotal = FEATURES.reduce(
      (n, f) => add(n, run.features[f].measured),
      ZERO,
    );
    const totalEstimate = estimate?.total ?? zeroEstimate;
    run.total = {
      estimate: totalEstimate,
      measured: measuredTotal,
      ratioHigh: ratio(measuredTotal.dollars, totalEstimate.high.dollars),
      ratioLow: ratio(measuredTotal.dollars, totalEstimate.low.dollars),
    };
    run.quality = {
      summary: quality(summaryAnswer ? [fromAnswer(summaryAnswer)] : []),
      briefs: quality(briefs.map(fromBrief)),
      answers: quality(answers.map(fromAnswer)),
    };
    const dollarsOf = (f: Feature): number => run.features[f].measured.dollars;
    run.perUnit = {
      breakdownDollarsPerBrief: ratio(dollarsOf('breakdown'), briefs.length),
      picturesDollarsPerBrief: ratio(dollarsOf('pictures'), briefs.length),
      examplesDollarsPerExample: ratio(
        dollarsOf('examples'),
        examplesDone ?? run.features.examples.measured.calls,
      ),
    };
    run.status = status;
    if (notes.length > 0) run.note = notes.join('; ');
    return run;
  }
}

function emptyRun(
  p: PlanRun,
  caps: { maxUsd: number; maxUsdPerRun: number },
): Run {
  const row = { low: ZERO, high: ZERO };
  return {
    bill: p.bill,
    url: p.url,
    plan: p.plan,
    answerModel: p.answerModel,
    extractModel: p.extractModel,
    breakdownMaxUnits: p.breakdownMaxUnits,
    pregenerateExamples: p.pregenerateExamples,
    status: 'completed',
    caps,
    features: {} as Run['features'],
    questions: { asked: 0, estimate: row, measured: ZERO, ratioHigh: null },
    other: ZERO,
    total: { estimate: row, measured: ZERO, ratioHigh: null, ratioLow: null },
    quality: {
      summary: quality([]),
      briefs: quality([]),
      answers: quality([]),
    },
    coverage: {
      briefs: 0,
      omitted: 0,
      eligible: 0,
      pictures: 0,
      examples: null,
    },
    perUnit: {
      breakdownDollarsPerBrief: null,
      picturesDollarsPerBrief: null,
      examplesDollarsPerExample: null,
    },
    spentUsd: 0,
    elapsedSeconds: 0,
  };
}

// --- command line -----------------------------------------------------------------------------

/** The runtime with every model call answered by the mock provider; costs nothing. */
export async function dryRuntime(base?: CliRuntime): Promise<CliRuntime> {
  const real = base ?? (await createRuntime({ needsLlm: false }));
  const mock = new MockProvider();
  return Object.create(real, {
    answerProvider: { value: mock, enumerable: true },
    extractProvider: { value: mock, enumerable: true },
    providerFor: {
      value: (_role: 'answer' | 'extract', model?: string) =>
        new MockProvider(model),
      enumerable: true,
    },
  }) as CliRuntime;
}

async function writeOutput(
  target: string,
  text: string,
  log: (l: string) => void,
): Promise<void> {
  if (target.startsWith('gs://')) {
    log(
      'CALIBRATION_OUT is a gs:// URL, but @google-cloud/storage is not installed; the report is on stdout only.',
    );
    return;
  }
  const path = resolve(target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  log(`report written to ${path}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'max-usd': { type: 'string', default: '10' },
      'max-usd-per-bill': { type: 'string', default: '3' },
      plan: { type: 'string' },
      only: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'poll-seconds': { type: 'string', default: '3' },
      'idle-seconds': { type: 'string', default: '20' },
      'run-timeout-minutes': { type: 'string', default: '10' },
      'deadline-minutes': { type: 'string', default: '210' },
    },
  });
  const num = (name: string, v: string | undefined): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`--${name} must be a positive number`);
    return n;
  };
  const log = (line: string): void => {
    console.error(line);
  };
  let plan = values.plan
    ? z.array(PlanRun).parse(JSON.parse(await readFile(values.plan, 'utf8')))
    : defaultPlan();
  if (values.only) {
    const only = values.only.toLowerCase();
    plan = plan.filter((p) => p.bill.toLowerCase().includes(only));
  }
  const dryRun = values['dry-run'];
  const report = await runCalibration({
    runtime: dryRun
      ? await dryRuntime()
      : await createRuntime({ needsLlm: true }),
    plan,
    maxUsd: num('max-usd', values['max-usd']),
    maxUsdPerRun: num('max-usd-per-bill', values['max-usd-per-bill']),
    dryRun,
    pollMs: num('poll-seconds', values['poll-seconds']) * 1000,
    idleMs: num('idle-seconds', values['idle-seconds']) * 1000,
    runTimeoutMs:
      num('run-timeout-minutes', values['run-timeout-minutes']) * 60_000,
    deadlineAt:
      Date.now() + num('deadline-minutes', values['deadline-minutes']) * 60_000,
    // One line per finished run, so a job that is killed still leaves its measurements in the log.
    onRun: (run) => {
      console.log(`CALIBRATION RUN ${JSON.stringify(run)}`);
    },
    log,
  });
  // A prefixed line lands in the log's textPayload; a bare JSON line would become jsonPayload.
  console.log(`CALIBRATION REPORT ${JSON.stringify(report)}`);
  const out = process.env.CALIBRATION_OUT;
  if (out) await writeOutput(out, `${JSON.stringify(report, null, 2)}\n`, log);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
