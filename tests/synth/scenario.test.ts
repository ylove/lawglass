import { expect, it } from 'vitest';
import { Chunk, Scenario, StoredChunk } from '../../src/core/model/index.js';
import { exampleScenario, noRateBill, scenarioExcerpts } from './scenario.js';

it('generates schema-valid scenario test data and a hostile bill with no rate', () => {
  expect(Scenario.safeParse(exampleScenario()).success).toBe(true);
  expect(Chunk.safeParse(noRateBill()).success).toBe(true);
  expect(StoredChunk.safeParse(scenarioExcerpts()[0]!.chunk).success).toBe(
    true,
  );
  expect(noRateBill().text).not.toMatch(/\d/);
});
