import { describe, expect, it } from 'vitest';
import { AppError } from '../model/index.js';
import {
  MAX_QUESTION_LENGTH,
  cleanQuestion,
  stripInvisibles,
} from './question.js';

describe('cleanQuestion', () => {
  it('trims and returns an ordinary question unchanged', () => {
    expect(cleanQuestion('  What are the grants?  ')).toBe(
      'What are the grants?',
    );
  });

  it('accepts exactly the cap and rejects one over, with a plain message', () => {
    expect(cleanQuestion('a'.repeat(MAX_QUESTION_LENGTH))).toHaveLength(500);
    let caught: unknown;
    try {
      cleanQuestion('a'.repeat(MAX_QUESTION_LENGTH + 1));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('INVALID_INPUT');
    expect((caught as AppError).userMessage).toBe(
      'Keep the question to 500 characters or fewer.',
    );
  });

  it('cannot dodge the cap by padding with invisible characters', () => {
    expect(() => cleanQuestion('hi' + '​'.repeat(600))).toThrow(AppError);
  });

  it('rejects empty input, including input that is only invisible characters', () => {
    for (const q of ['', '   ', '​‮﻿'])
      expect(() => cleanQuestion(q)).toThrow('Empty question.');
  });

  it('removes bidi controls and zero-width characters', () => {
    expect(cleanQuestion('ig​nore ‮previous‬⁦x⁩﻿')).toBe('ignore previousx');
  });
});

describe('stripInvisibles', () => {
  it.each(['​', '‌', '‍', '‎', '‏', '‪', '‮', '⁠', '⁦', '⁩', '؜', '﻿', '­'])(
    'removes U+%s',
    (ch) => {
      expect(stripInvisibles(`a${ch}b`)).toBe('ab');
    },
  );

  it('keeps visible text, spaces and non-Latin scripts', () => {
    expect(stripInvisibles('añ 日本 ש')).toBe('añ 日本 ש');
  });
});
