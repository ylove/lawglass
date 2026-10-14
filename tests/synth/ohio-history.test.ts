import { expect, test } from 'vitest';
import { makeOhioHistoryPages } from './ohio-history.js';

test('Ohio synthetic pages are deterministic and use invented bill data', () => {
  expect(makeOhioHistoryPages()).toEqual(makeOhioHistoryPages());
  for (const html of Object.values(makeOhioHistoryPages())) {
    expect(html).toContain('House Bill 9001');
    expect(html).toContain('Alex Example');
  }
});
