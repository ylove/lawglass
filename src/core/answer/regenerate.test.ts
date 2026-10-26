import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { envVar } from '../brand.js';
import {
  DECLINE_TEXT,
  messageText,
  type AnswerResult,
  type LlmProvider,
  type LlmStreamEvent,
  type TextRequest,
} from '../model/index.js';
import { answer } from './answer.js';
import { hit } from './fixtures.js';
import { fleschKincaidGrade } from './readability.js';
import {
  DEFAULT_INTERACTIVE_GRADE_MAX,
  DEFAULT_READING_GRADE_MAX,
  interactiveReadingGradeCeiling,
  PLAIN_LANGUAGE_INSTRUCTION,
  REGENERATION_VERSION,
  citesAmendedText,
  readingGradeCeiling,
  refuseRegeneration,
} from './regenerate.js';
import type { AnswerLogEvent } from './log.js';

const HARD =
  'The Administrator shall promulgate regulations establishing eligibility requirements for participating municipalities, which must demonstrate substantial compliance with applicable environmental standards [S:sec-1]. Each qualifying municipality receives $50,000 annually for 3 years [S:sec-1].';
const EASY =
  'The agency must write rules. Towns must follow them to take part [S:sec-1]. Each town gets $50,000 each year for 3 years [S:sec-1].';

const hits = [
  hit({ id: 'c1', sectionId: 'sec-1', text: 'Towns get $50,000 for 3 years.' }),
];

/** Replies `first` to the ordinary prompt and `second` once the plain-language instruction is in it. */
function twoStep(first: string, second: string) {
  return new ScriptedProvider({
    reply: (req) =>
      JSON.stringify(req.messages).includes('6th-grade reader')
        ? second
        : first,
  });
}

const base = {
  question: 'What do towns get?',
  context: { hits },
  readingLevel: { maxGrade: 8 },
};

describe('readingGradeCeiling', () => {
  it('defaults to 8, reads the env var, and treats 0 as off', () => {
    expect(readingGradeCeiling({})).toBe(DEFAULT_READING_GRADE_MAX);
    expect(readingGradeCeiling({ [envVar('READING_GRADE_MAX')]: '6' })).toBe(6);
    expect(readingGradeCeiling({ [envVar('READING_GRADE_MAX')]: '0' })).toBe(0);
  });
  it('ignores a malformed value rather than disabling the check', () => {
    for (const bad of ['abc', '-1', '', ' ', '8px'])
      expect(readingGradeCeiling({ [envVar('READING_GRADE_MAX')]: bad })).toBe(
        DEFAULT_READING_GRADE_MAX,
      );
  });
  it('has a version that follows the instruction', () => {
    expect(REGENERATION_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });
});

const MID =
  'The department must establish eligibility rules for towns that want to participate [S:sec-1]. Each town receives $50,000 every year for 3 years [S:sec-1].';
const HIGH =
  'The department must establish eligibility requirements for towns that want to participate [S:sec-1]. Each town receives $50,000 every year for 3 years [S:sec-1].';

describe('interactive and background ceilings', () => {
  it('reads the interactive ceiling from the environment; 0 disables it', () => {
    expect(interactiveReadingGradeCeiling({})).toBe(
      DEFAULT_INTERACTIVE_GRADE_MAX,
    );
    expect(
      interactiveReadingGradeCeiling({
        [envVar('READING_GRADE_MAX_INTERACTIVE')]: '12',
      }),
    ).toBe(12);
    expect(
      interactiveReadingGradeCeiling({
        [envVar('READING_GRADE_MAX_INTERACTIVE')]: '0',
      }),
    ).toBe(0);
    expect(
      interactiveReadingGradeCeiling({
        [envVar('READING_GRADE_MAX_INTERACTIVE')]: 'x',
      }),
    ).toBe(DEFAULT_INTERACTIVE_GRADE_MAX);
  });

  it('checks the grades the tests rely on sit around the two ceilings', () => {
    expect(fleschKincaidGrade(MID)).toBeGreaterThan(8);
    expect(fleschKincaidGrade(MID)).toBeLessThanOrEqual(10);
    expect(fleschKincaidGrade(HIGH)).toBeGreaterThan(10);
  });

  it('an interactive answer between 8 and 10 is left alone; above 10 it is regenerated', async () => {
    const mid = twoStep(MID, EASY);
    await answer({ ...base, provider: mid, readingLevel: {} });
    expect(mid.calls).toHaveLength(1);
    const high = twoStep(HIGH, EASY);
    const r = await answer({ ...base, provider: high, readingLevel: {} });
    expect(high.calls).toHaveLength(2);
    expect(r.simplified).toBe(true);
  });

  it('a background answer between 8 and 10 is regenerated', async () => {
    const mid = twoStep(MID, EASY);
    const r = await answer({
      ...base,
      provider: mid,
      readingLevel: { background: true },
    });
    expect(mid.calls).toHaveLength(2);
    expect(r.simplified).toBe(true);
  });
});

describe('regeneration', () => {
  it('replaces a too-hard answer with a regenerated one and adds the usage', async () => {
    const provider = twoStep(HARD, EASY);
    const tokens: string[] = [];
    const r = await answer({
      ...base,
      provider,
      chipInstruction: 'Be brief.',
      onToken: (t) => tokens.push(t),
    });
    expect(r.text).toBe(EASY);
    expect(r.simplified).toBe(true);
    expect(r.readingGrade).toBe(fleschKincaidGrade(EASY));
    expect(r.citations.map((c) => c.sectionId)).toEqual(['sec-1']);
    expect(provider.calls).toHaveLength(2);
    // The reader saw only the first attempt stream.
    expect(tokens.join('')).toBe(HARD);
    // Same question and context; the instruction is appended to the chip's own.
    const second = messageText(
      (provider.calls[1] as TextRequest).messages[0]?.content ?? '',
    );
    expect(second).toContain('<question>What do towns get?</question>');
    expect(second).toContain('Be brief. ');
    expect(second).toContain(PLAIN_LANGUAGE_INSTRUCTION.slice(0, 40));
    // Usage of both calls (the scripted provider charges 1 input token per call).
    expect(r.usage.inputTokens).toBe(2);
    expect(r.usage.outputTokens).toBeGreaterThan(
      (provider.calls[0] ? 1 : 0) + 10,
    );
  });

  it('reads the same cached bill prefix in whole mode', async () => {
    const provider = twoStep(HARD, EASY);
    const r = await answer({
      ...base,
      provider,
      context: { hits, mode: 'whole' },
    });
    expect(r.simplified).toBe(true);
    expect(r.context).toBe('whole');
    const parts = provider.calls.map(
      (c) => (c as TextRequest).messages[0]?.content,
    );
    expect(Array.isArray(parts[0])).toBe(true);
    expect((parts[0] as { text: string }[])[0]).toEqual(
      (parts[1] as { text: string }[])[0],
    );
  });

  describe('keeps the first answer', () => {
    const refused = async (second: string) => {
      const log: AnswerLogEvent[] = [];
      const provider = twoStep(HARD, second);
      const r = await answer({
        ...base,
        provider,
        log: (e) => log.push(e),
      });
      expect(r.text).toBe(HARD);
      expect(r.simplified).toBeUndefined();
      // The second try was paid for, so it is counted.
      expect(r.usage.inputTokens).toBe(2);
      return log.filter((e) => e.event === 'regeneration_refused');
    };

    it('when it declines', async () => {
      expect(await refused(DECLINE_TEXT)).toEqual([
        { event: 'regeneration_refused', reason: 'DECLINED' },
      ]);
    });
    it('when it cites nothing valid', async () => {
      expect(await refused('Towns get money.')).toEqual([
        { event: 'regeneration_refused', reason: 'NO_CITATION' },
      ]);
    });
    it('when it brings a warning the first lacked', async () => {
      expect(await refused(`${EASY} It also bans cats [S:nope].`)).toEqual([
        { event: 'regeneration_refused', reason: 'NEW_WARNING' },
      ]);
    });
    it('when it drops a section the first answer cited', async () => {
      const two = [
        hits[0]!,
        hit({ id: 'c2', sectionId: 'sec-2', text: 'Unless a town opts out.' }),
      ];
      const log: AnswerLogEvent[] = [];
      const first = `${HARD} Towns may opt out [S:sec-2].`;
      const provider = twoStep(first, EASY);
      const r = await answer({
        ...base,
        provider,
        context: { hits: two },
        log: (e) => log.push(e),
      });
      expect(r.text).toBe(first);
      expect(log).toContainEqual({
        event: 'regeneration_refused',
        reason: 'DROPPED_SECTION',
      });
    });
    it('when it is not simpler', async () => {
      expect(await refused(HARD)).toEqual([
        { event: 'regeneration_refused', reason: 'NOT_SIMPLER' },
      ]);
    });
  });

  it('keeps the first answer when the second call fails', async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      id: 'mock',
      model: 'm',
      streamText: async function* (req: TextRequest) {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        yield* new ScriptedProvider({ reply: HARD }).streamText(req);
      },
      generateObject: () => Promise.reject(new Error('no')),
    };
    const log: AnswerLogEvent[] = [];
    const r = await answer({
      ...base,
      provider: flaky,
      log: (e) => log.push(e),
    });
    expect(r.text).toBe(HARD);
    expect(log).toContainEqual({
      event: 'regeneration_refused',
      reason: 'ERROR',
    });
  });

  it('gives up after the timeout and shows the first answer', async () => {
    let calls = 0;
    const slow: LlmProvider = {
      id: 'mock',
      model: 'm',
      streamText: async function* (
        req: TextRequest,
      ): AsyncGenerator<LlmStreamEvent> {
        calls += 1;
        if (calls === 2)
          await new Promise((_, reject) => {
            req.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          });
        yield* new ScriptedProvider({ reply: HARD }).streamText(req);
      },
      generateObject: () => Promise.reject(new Error('no')),
    };
    const log: AnswerLogEvent[] = [];
    const r = await answer({
      ...base,
      provider: slow,
      readingLevel: { maxGrade: 8, timeoutMs: 20 },
      log: (e) => log.push(e),
    });
    expect(r.text).toBe(HARD);
    expect(r.usage.inputTokens).toBe(1);
    expect(log).toContainEqual({
      event: 'regeneration_refused',
      reason: 'TIMEOUT',
    });
  });

  it('rethrows an abort by the caller', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider({
      reply: () => {
        controller.abort();
        return HARD;
      },
    });
    await expect(
      answer({ ...base, provider, signal: controller.signal }),
    ).rejects.toThrow();
  });

  describe('is skipped', () => {
    const skipped = async (
      over: Parameters<typeof answer>[0] extends infer T ? Partial<T> : never,
    ) => {
      const provider = twoStep(HARD, EASY);
      const r = await answer({ ...base, provider, ...over });
      expect(provider.calls).toHaveLength(1);
      expect(r.simplified).toBeUndefined();
      return r;
    };
    it('when readingLevel is not set', async () => {
      await skipped({ readingLevel: undefined });
    });
    it('when the ceiling is 0', async () => {
      await skipped({ readingLevel: { maxGrade: 0 } });
    });
    it('at the ceiling, but not just above it', async () => {
      const grade = fleschKincaidGrade(HARD) ?? 0;
      await skipped({ readingLevel: { maxGrade: grade } });
      const provider = twoStep(HARD, EASY);
      await answer({
        ...base,
        provider,
        readingLevel: { maxGrade: grade - 0.1 },
      });
      expect(provider.calls).toHaveLength(2);
    });
    it('for a decline', async () => {
      const provider = twoStep(DECLINE_TEXT, EASY);
      await answer({ ...base, provider });
      expect(provider.calls).toHaveLength(1);
    });
    it('for a truncated answer', async () => {
      const cut: LlmProvider = {
        id: 'mock',
        model: 'm',
        streamText: async function* () {
          await Promise.resolve();
          yield { type: 'text', text: HARD };
          yield {
            type: 'done',
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'max_tokens',
          };
        },
        generateObject: () => Promise.reject(new Error('no')),
      };
      const r = await answer({ ...base, provider: cut });
      expect(r.warnings).toContain('TRUNCATED');
      expect(r.simplified).toBeUndefined();
    });
    it('for an answer about changes (exactWording)', async () => {
      await skipped({ exactWording: true });
    });
    it.each([
      { amendmentStatus: 'inserted' as const },
      { amendmentStatus: 'deleted' as const },
      { text: 'Pay [struck]$5[/struck] [inserted]$7[/inserted].' },
    ])('when the answer cites amended text %#', async (over) => {
      await skipped({
        context: {
          hits: [hit({ id: 'c1', sectionId: 'sec-1', text: 'x', ...over })],
        },
      });
    });
    it('but not when only an uncited section is amended', async () => {
      const provider = twoStep(HARD, EASY);
      await answer({
        ...base,
        provider,
        context: {
          hits: [
            hits[0]!,
            hit({
              id: 'c2',
              sectionId: 'sec-2',
              text: 'y',
              amendmentStatus: 'inserted',
            }),
          ],
        },
      });
      expect(provider.calls).toHaveLength(2);
    });
  });
});

describe('refuseRegeneration', () => {
  const result = (over: Partial<AnswerResult>): AnswerResult => ({
    text: 't',
    citations: [{ sectionId: 'a', valid: true, chunkIds: [] }],
    invalidCitations: [],
    warnings: [],
    declined: false,
    readingGrade: 10,
    provider: 'mock',
    model: 'm',
    usage: { inputTokens: 1, outputTokens: 1 },
    ...over,
  });
  it('accepts a simpler, cited, warning-free answer', () => {
    expect(
      refuseRegeneration(result({}), result({ readingGrade: 6 })),
    ).toBeNull();
  });
  it('tolerates a warning the first answer already had', () => {
    const first = result({ warnings: ['INVALID_CITATIONS_REMOVED'] });
    expect(
      refuseRegeneration(
        first,
        result({ readingGrade: 6, warnings: ['INVALID_CITATIONS_REMOVED'] }),
      ),
    ).toBeNull();
  });
  it('refuses a second answer that drops a section the first cited, but allows more', () => {
    const cites = (...ids: string[]) =>
      ids.map((sectionId) => ({ sectionId, valid: true, chunkIds: [] }));
    const first = result({ citations: cites('a', 'b', 'c') });
    expect(
      refuseRegeneration(
        first,
        result({ readingGrade: 6, citations: cites('a') }),
      ),
    ).toBe('DROPPED_SECTION');
    expect(
      refuseRegeneration(
        first,
        result({ readingGrade: 6, citations: cites('z') }),
      ),
    ).toBe('DROPPED_SECTION');
    expect(
      refuseRegeneration(
        first,
        result({ readingGrade: 6, citations: cites('a', 'b', 'c', 'd') }),
      ),
    ).toBeNull();
    // An invalid citation on the first answer is not something to preserve.
    expect(
      refuseRegeneration(
        result({
          citations: [
            ...cites('a'),
            { sectionId: 'bad', valid: false, chunkIds: [] },
          ],
        }),
        result({ readingGrade: 6 }),
      ),
    ).toBeNull();
  });

  it('refuses an unmeasurable grade', () => {
    expect(refuseRegeneration(result({}), result({ readingGrade: null }))).toBe(
      'NOT_SIMPLER',
    );
  });
  it('refuses a new TRUNCATED warning', () => {
    expect(
      refuseRegeneration(
        result({}),
        result({ readingGrade: 6, warnings: ['TRUNCATED'] }),
      ),
    ).toBe('NEW_WARNING');
  });
});

describe('citesAmendedText', () => {
  it('ignores invalid citations', () => {
    expect(
      citesAmendedText(
        { citations: [{ sectionId: 'sec-1', valid: false, chunkIds: [] }] },
        [
          hit({
            id: 'c',
            sectionId: 'sec-1',
            text: 'x',
            amendmentStatus: 'deleted',
          }),
        ],
      ),
    ).toBe(false);
  });
});
