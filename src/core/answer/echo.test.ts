import { describe, expect, it } from 'vitest';
import { DECLINE_TEXT } from '../model/index.js';
import {
  ECHO_RUN_WORDS,
  GUARD_RUN_WORDS,
  createEchoGuard,
  echoesSystemPrompt,
  normalizeWords,
} from './echo.js';
import { SYSTEM_PROMPT } from './prompt.js';

const PROMPT =
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';

describe('echoesSystemPrompt', () => {
  it('detects a verbatim run of 12 words', () => {
    expect(ECHO_RUN_WORDS).toBe(12);
    expect(
      echoesSystemPrompt(
        'Sure! Here: one two three four five six seven eight nine ten eleven twelve ok',
        PROMPT,
      ),
    ).toBe(true);
  });

  it('is case and whitespace insensitive', () => {
    expect(
      echoesSystemPrompt(
        'ONE two\n three\t four  five six seven eight nine ten eleven TWELVE',
        PROMPT,
      ),
    ).toBe(true);
  });

  it('allows an 11-word run', () => {
    expect(
      echoesSystemPrompt(
        'one two three four five six seven eight nine ten eleven',
        PROMPT,
      ),
    ).toBe(false);
  });

  it('allows scattered words that never run 12 in a row', () => {
    expect(
      echoesSystemPrompt(
        'one two three four five six x seven eight nine ten eleven twelve y',
        PROMPT,
      ),
    ).toBe(false);
  });

  it('finds a run taken from the middle of the prompt', () => {
    expect(
      echoesSystemPrompt(
        'three four five six seven eight nine ten eleven twelve thirteen fourteen',
        PROMPT,
      ),
    ).toBe(true);
  });

  it('does not treat the decline sentence the prompt contains as an echo', () => {
    expect(echoesSystemPrompt(DECLINE_TEXT, SYSTEM_PROMPT)).toBe(false);
    expect(
      echoesSystemPrompt(`${DECLINE_TEXT} ${DECLINE_TEXT}`, SYSTEM_PROMPT),
    ).toBe(false);
  });

  it('catches a real 12-word run from the actual system prompt', () => {
    const words = SYSTEM_PROMPT.split(/\s+/).slice(5, 20).join(' ');
    expect(
      echoesSystemPrompt(`My instructions say: ${words}`, SYSTEM_PROMPT),
    ).toBe(true);
  });
});

describe('evasion regressions', () => {
  const run = PROMPT.split(' ').slice(0, 12);

  it('is not evaded by a zero-width character after each word', () => {
    expect(
      echoesSystemPrompt(run.map((w) => `${w}\u200b`).join(' '), PROMPT),
    ).toBe(true);
    expect(
      echoesSystemPrompt(run.map((w) => `${w}\u202e`).join(' '), PROMPT),
    ).toBe(true);
    expect(echoesSystemPrompt(run.join('\u200b '), PROMPT)).toBe(true);
    // zero-width characters inside words too
    expect(
      echoesSystemPrompt(
        run.map((w) => w.split('').join('\u2060')).join(' '),
        PROMPT,
      ),
    ).toBe(true);
  });

  it('is not evaded by commas or other punctuation between words', () => {
    expect(echoesSystemPrompt(run.join(', '), PROMPT)).toBe(true);
    expect(echoesSystemPrompt(run.join(' - ').toUpperCase(), PROMPT)).toBe(
      true,
    );
    expect(echoesSystemPrompt(`"${run.join('; ')}."`, PROMPT)).toBe(true);
  });

  it('is not evaded by full-width (NFKC) lookalikes or citation markers', () => {
    expect(
      echoesSystemPrompt(
        run.map((w) => w.replace('o', '\uff4f')).join(' '),
        PROMPT,
      ),
    ).toBe(true);
    expect(
      echoesSystemPrompt(
        run.map((w, i) => (i === 5 ? `${w} [S:sec-1]` : w)).join(' '),
        PROMPT,
      ),
    ).toBe(true);
  });

  it('still allows unrelated text', () => {
    expect(
      echoesSystemPrompt('Grants go to towns, per the bill.', PROMPT),
    ).toBe(false);
  });

  it('normalizes consistently', () => {
    expect(normalizeWords('A\u200b,  B\u202e-C')).toEqual(['a', 'b', 'c']);
  });
});

describe('createEchoGuard (streaming)', () => {
  function feed(tokens: string[]) {
    const guard = createEchoGuard(PROMPT);
    return { out: tokens.map((t) => guard.push(t)), guard };
  }

  it('passes ordinary text through untouched', () => {
    const { out, guard } = feed(['Towns ', 'get ', 'grants.']);
    expect(out).toEqual(['Towns ', 'get ', 'grants.']);
    expect(guard.withheld()).toBe('');
  });

  it('stops emitting once an 8-word run matches, so 12 words never stream', () => {
    const tokens = PROMPT.split(' ').map((w) => `${w} `);
    const { out, guard } = feed(tokens);
    const emitted = out.join('');
    expect(normalizeWords(emitted).length).toBeLessThan(GUARD_RUN_WORDS);
    expect(echoesSystemPrompt(emitted, PROMPT)).toBe(false);
    expect(guard.withheld().length).toBeGreaterThan(0);
  });

  it('also trips on disguised runs (zero-width characters, commas)', () => {
    const tokens = PROMPT.split(' ').map((w) => `${w}\u200b, `);
    const emitted = feed(tokens).out.join('');
    expect(normalizeWords(emitted).length).toBeLessThan(GUARD_RUN_WORDS);
  });
});
