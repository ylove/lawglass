import { describe, expect, it } from 'vitest';
import { answerBlocks, listItems } from './list-items.js';

const SUMMARY = [
  'The Act sets up a system for payment stablecoins [S:sec-2].',
  '',
  'Main parts:',
  '',
  '- Who can issue: bank subsidiaries and state-approved issuers [S:sec-4].',
  '* Reserves: at least 1 to 1 backing [S:sec-4/a].',
  '',
  'More:',
  '1. Monthly reports [S:sec-4/c].',
  '2. No interest paid to holders [S:sec-4/d].',
].join('\n');

describe('answerBlocks', () => {
  it('splits paragraphs and lists, keeping list kinds and starts', () => {
    expect(
      answerBlocks(SUMMARY).map((b) => [b.kind, b.lines.length, b.start]),
    ).toEqual([
      ['p', 1, 1],
      ['p', 1, 1],
      ['ul', 2, 1],
      ['p', 1, 1],
      ['ol', 2, 1],
    ]);
  });

  it('keys blocks by their first source line and handles CRLF', () => {
    expect(answerBlocks('a\r\n\r\n- b\r\n- c').map((b) => b.key)).toEqual([
      0, 2,
    ]);
    expect(answerBlocks('3. three\n4. four')[0]?.start).toBe(3);
  });
});

describe('listItems', () => {
  it('numbers items across every list, in reading order, text as written', () => {
    expect(listItems(SUMMARY)).toEqual([
      {
        index: 0,
        text: 'Who can issue: bank subsidiaries and state-approved issuers [S:sec-4].',
      },
      { index: 1, text: 'Reserves: at least 1 to 1 backing [S:sec-4/a].' },
      { index: 2, text: 'Monthly reports [S:sec-4/c].' },
      { index: 3, text: 'No interest paid to holders [S:sec-4/d].' },
    ]);
  });

  it('has no items for prose, and ignores a bullet with nothing after it', () => {
    expect(listItems('Just one paragraph.\nAnd another line.')).toEqual([]);
    expect(listItems('-\n- real')).toEqual([{ index: 0, text: 'real' }]);
  });
});
