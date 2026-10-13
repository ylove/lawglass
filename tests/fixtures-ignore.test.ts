import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test.each([
  'fixtures/downloads/sample.xml',
  'fixtures/downloads/sample.xml.mismatch',
])('git ignores %s', (path) => {
  const result = spawnSync('git', ['check-ignore', '--no-index', path], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(path);
});
