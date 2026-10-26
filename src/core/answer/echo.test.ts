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

  it('retains words split across events', () => {
    const { out, guard } = feed(Array.from(PROMPT));
    // An unfinished prefix of the eighth word may stream before that word matches.
    expect(normalizeWords(out.join('')).length).toBeLessThan(ECHO_RUN_WORDS);
    expect(guard.withheld()).toContain('twelve');
  });

  it.each([
    ['one two three [S:long citation] four five six seven eight'],
    ['one two three [S:long ', 'citation] four five six seven eight'],
    ['one two three [S', ':long ', 'citation] four five six seven eight'],
    ['one two three [S:long [S:nested ', 'citation] four five six seven eight'],
  ])(
    'removes whole citation markers without breaking word history: %j',
    (...tokens) => {
      const { out, guard } = feed(tokens);
      expect(
        echoesSystemPrompt(`${tokens.join('')} nine ten eleven twelve`, PROMPT),
      ).toBe(true);
      expect(normalizeWords(out.join('')).length).toBeLessThan(GUARD_RUN_WORDS);
      expect(guard.withheld()).toContain('eight');
    },
  );
});

describe('default-ignorable characters and huge events', () => {
  const run = PROMPT.split(' ').slice(0, 12);

  it.each([
    ['variation selector', '\ufe0f'],
    ['combining grapheme joiner', '\u034f'],
    ['tag character', '\u{e0041}'],
    ['Hangul filler', '\u3164'],
    ['halfwidth Hangul filler', '\uffa0'],
    ['Mongolian vowel separator', '\u180e'],
    ['combining acute accent', '\u0301'],
  ])('is not evaded by a %s inside every word', (_name, ch) => {
    const disguised = run
      .map((w) => `${w.slice(0, 2)}${ch}${w.slice(2)}`)
      .join(' ');
    expect(echoesSystemPrompt(disguised, PROMPT)).toBe(true);
    const guard = createEchoGuard(PROMPT);
    const out = disguised
      .split(' ')
      .map((w) => guard.push(`${w} `))
      .join('');
    expect(normalizeWords(out).length).toBeLessThan(GUARD_RUN_WORDS);
  });

  it('withholds a recital delivered as one huge event followed by lots of filler', () => {
    const guard = createEchoGuard(PROMPT);
    const filler = ' Grants go to eligible towns under the bill.'.repeat(40);
    const out = guard.push(`${PROMPT}${filler}`);
    expect(out).toBe('');
    expect(guard.withheld()).toContain('eleven twelve');
  });

  it('catches a recital that follows a long clean prefix inside one event', () => {
    const guard = createEchoGuard(PROMPT);
    const prefix = 'The fee is fifty dollars per permit in the city. '.repeat(
      30,
    );
    expect(guard.push(`${prefix}${PROMPT}`)).toBe('');
  });

  it('catches a run split across two events', () => {
    const guard = createEchoGuard(PROMPT);
    const words = PROMPT.split(' ');
    const first = guard.push(`${words.slice(0, 5).join(' ')} `);
    const second = guard.push(`${words.slice(5).join(' ')} `);
    expect(first).not.toBe('');
    expect(second).toBe('');
  });
});
