import { describe, expect, it } from 'vitest';
import { splitSentences } from './sentences.js';

describe('splitSentences', () => {
  it('joins back to the original text exactly', () => {
    const text = 'One. Two!  Three?\n- Four [S:a]\n\nFive';
    expect(splitSentences(text).join('')).toBe(text);
  });

  it.each([
    'The bill amends 42 U.S.C. 1395 to add a fee [S:a].',
    'See Sec. 4 for the rule [S:a].',
    'Fees, e.g. for permits, are $20 [S:a].',
    'The U.S. Department of Labor sets the wage [S:a].',
    'Dr. Smith is named [S:a].',
    'The fee is $1.50 per page [S:a].',
  ])('does not split inside: %s', (sentence) => {
    expect(splitSentences(sentence)).toEqual([sentence]);
    expect(splitSentences(`${sentence} Next one.`)).toHaveLength(2);
  });

  it('ends a sentence at "U.S." when an ordinary opener follows, not before a name', () => {
    expect(
      splitSentences('Grants apply in the U.S. The agency pays.'),
    ).toHaveLength(2);
    expect(splitSentences('The U.S. Department of Labor pays.')).toHaveLength(
      1,
    );
  });

  it('splits at line breaks and after ordinary sentence ends', () => {
    expect(splitSentences('A. B.\n- C\n- D')).toHaveLength(4);
  });

  it('is linear on long punctuation runs', () => {
    const start = Date.now();
    splitSentences(`${'.'.repeat(100_000)}x${'!'.repeat(100_000)}`);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
