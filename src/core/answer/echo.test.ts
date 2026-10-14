import { describe, expect, it } from 'vitest';
import { DECLINE_TEXT } from '../model/index.js';
import { ECHO_RUN_WORDS, echoesSystemPrompt } from './echo.js';
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
