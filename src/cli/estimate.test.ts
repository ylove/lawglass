import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { makeSectionedText } from '../../tests/synth/text.js';
import { BRAND, envVar } from '../core/brand.js';
import { resolveNewYork } from '../core/fetch/new-york.js';
import type { SafeFetchResult } from '../core/fetch/index.js';
import { createProgram } from './program.js';
import {
  createEstimateRuntime,
  estimateUrl,
  type EstimateReport,
  type EstimateRuntime,
} from './estimate.js';

const URL = 'https://example.com/bill.txt';
function runtime(): EstimateRuntime {
  const bytes = makeSectionedText().bytes;
  const fetched: SafeFetchResult = {
    fromCache: false,
    bytes,
    docId: createHash('sha256').update(bytes).digest('hex'),
    finalUrl: URL,
    format: 'text',
    contentType: 'text/plain',
  };
  return {
    fetcher: vi.fn().mockResolvedValue(fetched),
    now: () => new Date('2026-01-01T00:00:00Z'),
    plan: {
      answerModel: 'claude-sonnet-5-5',
      extractModel: 'claude-haiku-5-5',
    },
  };
}

it.each([false, true])(
  'estimate fetches/parses with no provider or retrieval runtime (json: %s)',
  async (json) => {
    const source = runtime();
    const fullRuntime = vi.fn(() => {
      throw new Error('Must not construct a provider or backend');
    });
    let output = '';
    await createProgram({
      estimateRuntime: () => Promise.resolve(source),
      runtime: fullRuntime,
      write: (text) => {
        output += text;
      },
    }).parseAsync(['estimate', URL, ...(json ? ['--json'] : [])], {
      from: 'user',
    });
    expect(source.fetcher).toHaveBeenCalledOnce();
    expect(fullRuntime).not.toHaveBeenCalled();
    if (json) {
      const report = JSON.parse(output) as EstimateReport;
      expect(report.facts.mode).toBe('whole');
      expect(report.facts.sectionCount).toBeGreaterThan(0);
      expect(report.estimate.total.high.dollars).toBeGreaterThan(0);
      expect(report.estimate.models).toEqual(source.plan);
    } else {
      for (const text of [
        'Sections:',
        'Characters:',
        'Mode: whole',
        'Input tokens',
        'Cache read',
        'Cache write',
        'Output tokens',
        'USD',
        'TOTAL',
        'Per question',
      ])
        expect(output).toContain(text);
    }
  },
);

it('reads configured model/rate overrides without API or backend credentials', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'estimate-config-'));
  try {
    const dir = join(homeDir, BRAND.configDirName);
    await mkdir(dir, { mode: 0o700 });
    const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        backend: 'pinecone',
        llmProvider: 'anthropic',
        answerModel: 'custom',
        costPrices: { custom: rates },
      }),
      { mode: 0o600 },
    );
    const result = await createEstimateRuntime({
      homeDir,
      env: { [envVar('EXTRACT_MODEL')]: 'claude-opus-5-5' },
    });
    expect(result.plan).toEqual({
      answerModel: 'custom',
      extractModel: 'claude-opus-5-5',
    });
    expect(result.prices).toEqual({ custom: rates });
    const fallback = await createEstimateRuntime({
      homeDir: join(homeDir, 'empty'),
      env: {},
    });
    expect(fallback.plan).toEqual(runtime().plan);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

it('uses ingest URL resolution for a New York landing page', async () => {
  const source = runtime();
  const url = 'https://www.nysenate.gov/legislation/bills/2025/S1';
  const resolved = resolveNewYork(url)!;
  const bytes = makeSectionedText().bytes;
  source.fetcher = vi.fn().mockResolvedValue({
    bytes,
    docId: createHash('sha256').update(bytes).digest('hex'),
    finalUrl: resolved.textUrl,
    contentType: 'text/plain',
    format: 'text',
  });
  await estimateUrl(url, source);
  expect(source.fetcher).toHaveBeenCalledWith(
    resolved.textUrl,
    expect.objectContaining({ validateUrl: expect.any(Function) as unknown }),
  );
});

it('checks fetched integrity and reports unknown model pricing', async () => {
  const source = runtime();
  await expect(
    estimateUrl(URL, {
      ...source,
      plan: { ...source.plan, answerModel: 'unknown' },
    }),
  ).rejects.toThrow('No price configured');
  const bad = {
    ...source,
    fetcher: vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1]),
      docId: 'a'.repeat(64),
      finalUrl: URL,
      format: 'text',
    }),
  };
  await expect(estimateUrl(URL, bad)).rejects.toMatchObject({
    code: 'FETCH_FAILED',
  });
});
