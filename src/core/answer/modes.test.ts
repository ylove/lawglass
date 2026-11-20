import { describe, expect, it } from 'vitest';
import type {
  LlmProvider,
  LlmStreamEvent,
  TextRequest,
} from '../model/index.js';
import { answer } from './answer.js';
import { hit } from './fixtures.js';
import {
  AnswerMode,
  DEFAULT_FOCUSED_MAX_TOKENS,
  DEFAULT_WHOLE_MAX_TOKENS,
  effortForCap,
  maxTokensFor,
  validateAnswerLimits,
} from './modes.js';

const hits = [
  hit({
    id: 'c1',
    sectionId: 'sec-1',
    text: 'The department shall award grants.',
  }),
];

describe('maxTokensFor', () => {
  it('defaults to the caps the pipeline always used', () => {
    expect(maxTokensFor('whole', undefined)).toBe(16_000);
    expect(maxTokensFor('focused', {})).toBe(8192);
    expect(DEFAULT_WHOLE_MAX_TOKENS).toBe(16_000);
    expect(DEFAULT_FOCUSED_MAX_TOKENS).toBe(8192);
  });
  it('takes the host value per mode', () => {
    const limits = { wholeMaxTokens: 12_000, focusedMaxTokens: 4096 };
    expect(maxTokensFor('whole', limits)).toBe(12_000);
    expect(maxTokensFor('focused', limits)).toBe(4096);
  });
});

describe('validateAnswerLimits', () => {
  it('accepts unset and sensible caps', () => {
    expect(() => {
      validateAnswerLimits(undefined);
      validateAnswerLimits({});
      validateAnswerLimits({ focusedMaxTokens: 4096, wholeMaxTokens: 16_000 });
    }).not.toThrow();
  });
  it.each([0, 1023, 4096.5, Number.NaN, -1])('refuses %s', (value) => {
    expect(() => {
      validateAnswerLimits({ focusedMaxTokens: value });
    }).toThrow(RangeError);
  });
});

describe('AnswerMode', () => {
  it('is auto, whole or focused', () => {
    expect(AnswerMode.options).toEqual(['auto', 'whole', 'focused']);
  });
});

describe('effortForCap', () => {
  it('leaves the caller effort alone at or above the default cap', () => {
    expect(effortForCap(undefined, 8192, 8192)).toBeUndefined();
    expect(effortForCap('medium', 16_000, 16_000)).toBe('medium');
    expect(effortForCap('high', 20_000, 16_000)).toBe('high');
  });
  it('shrinks reasoning with the cap', () => {
    expect(effortForCap(undefined, 4096, 8192)).toBe('low');
    expect(effortForCap('medium', 5999, 16_000)).toBe('low');
    expect(effortForCap(undefined, 7000, 8192)).toBe('medium');
    expect(effortForCap('high', 12_000, 16_000)).toBe('medium');
    expect(effortForCap('low', 12_000, 16_000)).toBe('low');
  });
});

/**
 * A model that thinks, as Claude 5.5 does: reasoning spends the same `maxTokens` as the visible
 * answer, and more effort means more reasoning. If the two do not fit, the reply is cut off.
 */
function thinkingProvider(): LlmProvider & { requests: TextRequest[] } {
  const reasoning = { low: 600, medium: 2500, high: 6000 };
  const requests: TextRequest[] = [];
  return {
    id: 'mock',
    model: 'thinking',
    requests,
    generateObject: () => Promise.reject(new Error('not used')),
    // eslint-disable-next-line @typescript-eslint/require-await -- a generator, no awaiting needed
    async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
      requests.push(req);
      const thought = reasoning[req.effort ?? 'high'];
      const visible = 900;
      const room = req.maxTokens - thought;
      const fits = room >= visible;
      yield {
        type: 'text',
        text: fits ? 'The department awards grants [S:sec-1].' : '',
      };
      yield {
        type: 'done',
        usage: {
          inputTokens: 100,
          outputTokens: Math.min(req.maxTokens, thought + visible),
        },
        stopReason: fits ? 'end_turn' : 'max_tokens',
      };
    },
  };
}

describe('answer under a host cap', () => {
  it('keeps today caps and sends no effort for a focused answer', async () => {
    const provider = thinkingProvider();
    await answer({ provider, question: 'q', context: { hits } });
    expect(provider.requests[0]).toMatchObject({ maxTokens: 8192 });
    expect(provider.requests[0]?.effort).toBeUndefined();
  });

  it('a 4,096 cap lowers effort, so thinking leaves room and the answer is complete', async () => {
    const provider = thinkingProvider();
    const result = await answer({
      provider,
      question: 'q',
      context: { hits },
      limits: { focusedMaxTokens: 4096 },
    });
    expect(provider.requests[0]).toMatchObject({
      maxTokens: 4096,
      effort: 'low',
    });
    expect(result.warnings).not.toContain('TRUNCATED');
    expect(result.text).toBe('The department awards grants [S:sec-1].');
    expect(result.usage.outputTokens).toBeLessThanOrEqual(4096);
  });

  it('the thinking model really overruns a 4,096 cap at its default effort', async () => {
    // Guards the fixture: without the lowered effort the same call is cut off.
    const provider = thinkingProvider();
    const events: LlmStreamEvent[] = [];
    for await (const e of provider.streamText({
      system: '',
      messages: [],
      maxTokens: 4096,
    }))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ stopReason: 'max_tokens' });
  });

  it('an explicit maxTokens gets the same proportional effort', async () => {
    const provider = thinkingProvider();
    await answer({
      provider,
      question: 'q',
      context: { hits },
      maxTokens: 4096,
    });
    expect(provider.requests[0]).toMatchObject({
      maxTokens: 4096,
      effort: 'low',
    });
  });

  it('a whole-bill answer takes the whole cap and scales effort with it', async () => {
    const provider = thinkingProvider();
    await answer({
      provider,
      question: 'q',
      context: { mode: 'whole', hits },
      limits: { wholeMaxTokens: 9000, focusedMaxTokens: 4096 },
    });
    expect(provider.requests[0]).toMatchObject({
      maxTokens: 9000,
      effort: 'medium',
    });
  });

  it('a raised cap changes nothing else', async () => {
    const provider = thinkingProvider();
    await answer({
      provider,
      question: 'q',
      context: { hits },
      limits: { focusedMaxTokens: 20_000 },
    });
    expect(provider.requests[0]).toMatchObject({ maxTokens: 20_000 });
    expect(provider.requests[0]?.effort).toBeUndefined();
  });
});
