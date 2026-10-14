import { expect, test } from 'vitest';
import { makeOhioHistoryJson, makeOhioVersionsJson } from './ohio-history.js';

test('Ohio synthetic JSON is deterministic, invented and has seven versions', () => {
  expect(makeOhioHistoryJson()).toEqual(makeOhioHistoryJson());
  expect(makeOhioVersionsJson()).toHaveLength(7);
  expect(makeOhioHistoryJson().versions).toContain('Alex Example');
});
