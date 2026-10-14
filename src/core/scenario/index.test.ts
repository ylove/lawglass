import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  type LlmProvider,
  type ObjectRequest,
  type Scenario,
} from '../model/index.js';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { INJECTION_SAMPLES } from '../../../tests/synth/injection.js';
import {
  exampleScenario,
  noRateBill,
  scenarioExcerpts,
} from '../../../tests/synth/scenario.js';
import { personaName } from './generate.js';
import { createScenario } from './index.js';

function providerFor(scenario: Scenario): ScriptedProvider {
  return new ScriptedProvider({ objects: { scenario } });
}

describe('createScenario', () => {
  it('returns valid output after a single generation', async () => {
    const excerpts = scenarioExcerpts();
    const scenario = exampleScenario(personaName(excerpts));
    const provider = providerFor(scenario);
    expect(await createScenario({ provider, excerpts })).toEqual({
      scenario,
      dropped: [],
    });
    expect(provider.calls).toHaveLength(1);
  });

  it('regenerates exactly once when too few frames survive, preserving the same prompt', async () => {
    const excerpts = scenarioExcerpts();
    const good = exampleScenario(personaName(excerpts));
    const bad = structuredClone(good);
    bad.frames[1]!.citations = [];
    bad.frames[2]!.citations = [];
    const first = providerFor(bad);
    const second = providerFor(good);
    let attempts = 0;
    const provider: LlmProvider = {
      id: first.id,
      model: first.model,
      streamText: first.streamText.bind(first),
      generateObject<T>(request: ObjectRequest<T>) {
        attempts++;
        return (attempts === 1 ? first : second).generateObject(request);
      },
    };
    const generateObject = vi.spyOn(provider, 'generateObject');
    expect(
      (
        await createScenario({
          provider,
          excerpts,
          question: 'How terrible is this?',
        })
      ).scenario,
    ).toEqual(good);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect((first.calls[0] as ObjectRequest<unknown>).prompt).toBe(
      (second.calls[0] as ObjectRequest<unknown>).prompt,
    );
  });

  it('drops output after two invalid generations and after two schema failures', async () => {
    const excerpts = scenarioExcerpts();
    const bad = exampleScenario(personaName(excerpts));
    bad.frames[1]!.citations = [];
    bad.frames[2]!.citations = [];
    const provider = providerFor(bad);
    expect(
      (await createScenario({ provider, excerpts })).scenario,
    ).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    const malformed = new ScriptedProvider({
      objects: { scenario: { ...bad, frames: [] } },
    });
    expect(await createScenario({ provider: malformed, excerpts })).toEqual({
      dropped: [{ frameIndex: -1, reason: 'schema' }],
    });
    expect(malformed.calls).toHaveLength(2);
  });

  it('propagates operational errors without regeneration', async () => {
    const provider = providerFor(exampleScenario());
    const generateObject = vi
      .spyOn(provider, 'generateObject')
      .mockRejectedValue(new AppError('PROVIDER_ERROR'));
    await expect(
      createScenario({ provider, excerpts: [] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation before generation and between attempts', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = providerFor(exampleScenario());
    await expect(
      createScenario({ provider, excerpts: [], signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.calls).toHaveLength(0);
    const pending = new AbortController();
    vi.spyOn(provider, 'generateObject').mockImplementation(() => {
      pending.abort();
      return Promise.reject(new AppError('PROVIDER_BAD_OUTPUT'));
    });
    await expect(
      createScenario({ provider, excerpts: [], signal: pending.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a retrieved adversarial tax bill with no rates yields qualitative effects or a dropped scenario', async () => {
    const backend = new MemoryBackend();
    const bill = noRateBill();
    await backend.upsertChunks(bill.docId, [bill]);
    const { hits: excerpts } = await backend.search({
      docId: bill.docId,
      index: 'sparse',
      query: 'tax',
      topK: 5,
    });
    expect(excerpts).toHaveLength(1);
    const scenario = exampleScenario(personaName(excerpts));
    const result = await createScenario({
      provider: providerFor(scenario),
      excerpts,
    });
    expect(
      result.scenario?.frames
        .filter((frame) => frame.kind !== 'setup')
        .every((frame) => !frame.figures?.length),
    ).toBe(true);
    for (const frame of scenario.frames.slice(1)) {
      frame.caption = 'The rate is 4%.';
      frame.figures = [{ value: 4, unit: 'percent', source: 'bill' }];
    }
    expect(
      (await createScenario({ provider: providerFor(scenario), excerpts }))
        .scenario,
    ).toBeUndefined();
  });

  it('an injected excerpt cannot smuggle caption markup or arbitrary avatar/icon markup', async () => {
    const excerpts = scenarioExcerpts(INJECTION_SAMPLES[2]);
    const scenario = exampleScenario(personaName(excerpts));
    for (const frame of scenario.frames.slice(1))
      frame.caption = '<svg onload="attack()"></svg>';
    expect(
      (await createScenario({ provider: providerFor(scenario), excerpts }))
        .scenario,
    ).toBeUndefined();
    for (const field of ['avatar', 'icon']) {
      const hostile = {
        ...exampleScenario(personaName(excerpts)),
        frames: exampleScenario(personaName(excerpts)).frames.map((frame) => ({
          ...frame,
          [field]: '<img src=x>',
        })),
      };
      const provider = new ScriptedProvider({ objects: { scenario: hostile } });
      expect(
        (await createScenario({ provider, excerpts })).scenario,
      ).toBeUndefined();
    }
  });
});
