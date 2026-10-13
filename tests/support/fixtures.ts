import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import {
  downloadsDirectory,
  fixtureFilename,
  readManifest,
  verifyFixture,
} from '../../scripts/fixture-manifest.js';

export function fixturePath(name: string): string | undefined {
  const fixture = readManifest().fixtures.find((entry) => entry.name === name);
  if (!fixture) return undefined;
  const path = join(downloadsDirectory, fixtureFilename(fixture));
  try {
    return verifyFixture(readFileSync(path), fixture).matches
      ? path
      : undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

type RegisterSuite = (name: string, fn: () => void) => void;

export function describeWithFixture(
  name: string,
  fn: () => void,
  suite: { run: RegisterSuite; skip: RegisterSuite } = {
    run: describe,
    skip: describe.skip,
  },
): void {
  if (fixturePath(name)) {
    suite.run(name, fn);
  } else {
    suite.skip(
      `${name}: fixture absent or invalid; run npm run fixtures:fetch -- --only ${name}`,
      fn,
    );
  }
}
