/**
 * Golden set loading. Sets are authored elsewhere (src/eval/golden/*.json) and frozen by
 * commit; this module only validates and reads them. A file that fails the frozen `GoldenSet`
 * schema is reported and skipped rather than aborting the run: a half-written draft for one
 * fixture must not block evaluating the others.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GoldenSet } from '../core/model/index.js';

export interface InvalidGoldenFile {
  file: string;
  reason: string;
}

export interface LoadedGoldenSets {
  sets: GoldenSet[];
  invalid: InvalidGoldenFile[];
}

/** Load every `*.json` file in `directory` that validates. A missing directory is empty. */
export async function loadGoldenSets(
  directory: string,
): Promise<LoadedGoldenSets> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((n) => n.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { sets: [], invalid: [] };
    throw error;
  }
  const sets: GoldenSet[] = [];
  const invalid: InvalidGoldenFile[] = [];
  for (const name of names.sort()) {
    const file = join(directory, name);
    try {
      const parsed = GoldenSet.safeParse(
        JSON.parse(await readFile(file, 'utf8')),
      );
      if (parsed.success) sets.push(parsed.data);
      else
        invalid.push({
          file: name,
          reason: parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        });
    } catch (error) {
      invalid.push({
        file: name,
        reason: error instanceof Error ? error.message : 'unreadable',
      });
    }
  }
  return { sets, invalid };
}
