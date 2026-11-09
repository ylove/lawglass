import { resolveConfig, type ConfigOptions } from '../core/config.js';
import {
  safeFetch,
  defaultCacheDir,
  cacheBudgetBytes,
} from '../core/fetch/index.js';
import { wholeBillBudget } from '../core/answer/context.js';
import {
  fetchAndParseDocument,
  type ReadDocumentDeps,
} from '../core/pipeline/ingest.js';
import { breakdownMaxUnitsFromEnv } from '../core/breakdown/coverage.js';
import {
  billFacts,
  estimateBill,
  type BillEstimate,
  type BillFacts,
  type EstimatePlan,
  type PriceTable,
} from '../core/cost/index.js';
import { safeText } from './sanitize.js';

export interface EstimateRuntime extends ReadDocumentDeps {
  plan: EstimatePlan;
  prices?: PriceTable;
  wholeBillMaxTokens?: number;
}

/** No backend or provider is constructed, and no credential is required to quote a price. */
export async function createEstimateRuntime(
  options: ConfigOptions = {},
): Promise<EstimateRuntime> {
  const config = await resolveConfig({
    ...options,
    needsLlm: false,
    backend: 'local',
    isTTY: false,
  });
  const cacheDir = defaultCacheDir(config.configDir);
  return {
    plan: {
      answerModel: config.answerModel,
      extractModel: config.extractModel,
    },
    ...(config.costPrices ? { prices: config.costPrices } : {}),
    wholeBillMaxTokens: wholeBillBudget(),
    now: () => new Date(),
    fetcher: (url, opts) =>
      safeFetch(url, {
        ...opts,
        cacheDir,
        cacheBudgetBytes: cacheBudgetBytes(options.env ?? process.env),
        deferCacheWrite: true,
      }),
  };
}

export interface EstimateReport {
  facts: BillFacts;
  estimate: BillEstimate;
}
export async function estimateUrl(
  url: string,
  runtime: EstimateRuntime,
): Promise<EstimateReport> {
  const doc = await fetchAndParseDocument(url, runtime);
  const facts = billFacts(doc.sections, {
    // The same cap the server will run with, so the estimate prices what would be made.
    breakdownUnitCap: breakdownMaxUnitsFromEnv(),
    ...(runtime.wholeBillMaxTokens === undefined
      ? {}
      : { wholeBillMaxTokens: runtime.wholeBillMaxTokens }),
  });
  return { facts, estimate: estimateBill(facts, runtime.plan, runtime.prices) };
}

export function formatEstimate({ facts, estimate }: EstimateReport): string {
  const range = (low: number, high: number): string =>
    `${String(low)}–${String(high)}`;
  const dollars = (low: number, high: number): string =>
    `$${low.toFixed(4)}–$${high.toFixed(4)}`;
  const lines = [
    `Sections: ${String(facts.sectionCount)}  Characters: ${String(facts.characters)}  Estimated tokens: ${String(facts.estimatedTokens)}`,
    `Mode: ${facts.mode}  Breakdown units: ${String(facts.breakdownUnits)} (${String(facts.omittedBreakdownUnits)} omitted)  Map units: ${String(facts.mapUnits)}`,
    `Single subject: ${facts.singleSubject ? 'yes' : 'no'}  Estimated picture items: ${String(facts.eligiblePictureItems.summary + facts.eligiblePictureItems.breakdown)}`,
    `Answer model: ${estimate.models.answerModel}  Extract model: ${estimate.models.extractModel}`,
    '',
    `${'Feature'.padEnd(19)} ${'Calls'.padEnd(8)} ${'Input tokens'.padEnd(18)} ${'Cache read'.padEnd(18)} ${'Cache write'.padEnd(18)} ${'Output tokens'.padEnd(18)} USD`,
  ];
  for (const [name, value] of [
    ...Object.entries(estimate.features),
    ['TOTAL', estimate.total],
    ['Per question', estimate.question],
  ] as const) {
    const { low, high } = value;
    lines.push(
      `${name.padEnd(19)} ${range(low.calls, high.calls).padEnd(8)} ${range(low.inputTokens, high.inputTokens).padEnd(18)} ${range(low.cachedInputTokens, high.cachedInputTokens).padEnd(18)} ${range(low.cacheWriteTokens, high.cacheWriteTokens).padEnd(18)} ${range(low.outputTokens, high.outputTokens).padEnd(18)} ${dollars(low.dollars, high.dollars)}`,
    );
  }
  return safeText([...lines, '', ...estimate.assumptions, ''].join('\n'));
}
