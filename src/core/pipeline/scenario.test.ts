import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../../tests/support/pipeline-env.js';
import {
  scenarioProvider,
  type ScenarioProvider,
} from '../../../tests/support/scenario-provider.js';
import { makeSectionedText } from '../../../tests/synth/index.js';
import { envVar } from '../brand.js';
import { AppError } from '../model/index.js';
import { ask } from './ask.js';
import { ingest } from './ingest.js';
import { resetSharedLimits, sharedLimits } from './limits.js';
import { runScenario, type RunScenarioDeps } from './scenario.js';

let env: PipelineEnv;
let docId: string;
let provider: ScenarioProvider;

beforeEach(async () => {
  env = await makePipelineEnv();
  const url = 'https://example.gov/gardens.txt';
  env.serve(url, makeSectionedText(), 'text/plain');
  docId = (
    await ingest(url, {
      backend: env.backend,
      registry: env.registry,
      provider: env.provider,
      fetcher: env.runtime.fetcher,
      now: env.runtime.now,
    })
  ).doc.docId;
  provider = scenarioProvider(env.provider);
  vi.stubEnv(envVar('MAX_CONCURRENT_ASK'), '2');
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '100');
  resetSharedLimits();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetSharedLimits();
  await env.cleanup();
});

function deps(overrides: Partial<RunScenarioDeps> = {}): RunScenarioDeps {
  return {
    backend: env.backend,
    registry: env.registry,
    provider,
    ...overrides,
  };
}

describe('runScenario budgets', () => {
  it('refuses a bad subject before acquiring a permit', async () => {
    const limits = sharedLimits();
    const acquire = vi.spyOn(limits, 'acquire');
    await expect(
      runScenario(docId, 'unfair', deps({ limits })),
    ).rejects.toBeInstanceOf(AppError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('surfaces an acquisition failure before retrieval', async () => {
    const limits = sharedLimits();
    vi.spyOn(limits, 'acquire').mockRejectedValue(new AppError('RATE_LIMITED'));
    const retrieve = vi.spyOn(env.backend, 'search');
    await expect(
      runScenario(docId, 'a renter', deps({ limits })),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('queues five on-demand scenarios behind asks and keeps model concurrency within the shared cap', async () => {
    let finishAsks!: () => void;
    const askGate = new Promise<void>((resolve) => {
      finishAsks = resolve;
    });
    const stream = env.provider.streamText.bind(env.provider);
    const streamSpy = vi
      .spyOn(env.provider, 'streamText')
      .mockImplementation(async function* (req) {
        await askGate;
        yield* stream(req);
      });
    const asks = Promise.all(
      Array.from({ length: 2 }, () =>
        ask(docId, { question: 'garden grants' }, deps()),
      ),
    );
    await vi.waitFor(() => {
      expect(streamSpy).toHaveBeenCalledTimes(2);
    });

    let finishScenarios!: () => void;
    const scenarioGate = new Promise<void>((resolve) => {
      finishScenarios = resolve;
    });
    let active = 0;
    let peak = 0;
    const generate = provider.generateObject.bind(provider);
    const generateSpy = vi
      .spyOn(provider, 'generateObject')
      .mockImplementation(async (req) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await scenarioGate;
          return await generate(req);
        } finally {
          active -= 1;
        }
      });
    const scenarios = Promise.all(
      [
        'a renter',
        'a grantee',
        'a town',
        'a homeowner',
        'a grant applicant',
      ].map((subject) => runScenario(docId, subject, deps())),
    );
    try {
      await vi.waitFor(() => {
        expect(sharedLimits().pool('ask').queued).toBe(5);
      });
      expect(generateSpy).not.toHaveBeenCalled();
      finishAsks();
      await asks;
      await vi.waitFor(() => {
        expect(active).toBe(2);
      });
      expect(sharedLimits().pool('ask').queued).toBe(3);
    } finally {
      finishAsks();
      finishScenarios();
      await Promise.all([asks, scenarios]);
    }
    expect((await scenarios).every((result) => result.status === 'ok')).toBe(
      true,
    );
    expect(provider.scenarioCalls).toBe(5);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(sharedLimits().pool('ask').inFlight).toBe(0);
  });

  it('does not call the scenario model when an ask has exhausted the shared per-minute ceiling', async () => {
    vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1');
    resetSharedLimits();
    await ask(docId, { question: 'garden grants' }, deps());
    // Scenario attachment is best effort: a budget refusal produces none without a model call.
    expect(await runScenario(docId, 'a renter', deps())).toEqual({
      status: 'none',
    });
    expect(provider.scenarioCalls).toBe(0);
    expect(sharedLimits().pool('ask').inFlight).toBe(0);
  });

  it('charges on-demand generation to the same per-minute ceiling as asks', async () => {
    vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1');
    resetSharedLimits();
    expect((await runScenario(docId, 'a renter', deps())).status).toBe('ok');
    expect(await runScenario(docId, 'a grantee', deps())).toEqual({
      status: 'none',
    });
    expect(provider.scenarioCalls).toBe(1);
    await expect(
      ask(docId, { question: 'garden grants' }, deps()),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(sharedLimits().pool('ask').inFlight).toBe(0);
  });

  it('serves cached ok and none results without acquiring or metering', async () => {
    vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1');
    resetSharedLimits();
    const limits = sharedLimits();
    const first = await runScenario(docId, 'a renter', deps({ limits }));
    expect(first.status).toBe('ok');
    expect(await runScenario(docId, 'a grantee', deps({ limits }))).toEqual({
      status: 'none',
    });
    const acquire = vi.spyOn(limits, 'acquire');
    const meter = vi.spyOn(limits, 'meter');
    expect(await runScenario(docId, 'a renter', deps({ limits }))).toEqual(
      first,
    );
    expect(await runScenario(docId, 'a grantee', deps({ limits }))).toEqual({
      status: 'none',
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(meter).not.toHaveBeenCalled();
    expect(provider.scenarioCalls).toBe(1);
  });

  it('releases the permit on a retrieval failure', async () => {
    const limits = sharedLimits();
    await env.backend.deleteDocument(docId);
    await expect(
      runScenario(docId, 'a renter', deps({ limits })),
    ).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
    expect(limits.pool('ask').inFlight).toBe(0);
  });
});
