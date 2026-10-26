import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import lock from '../models.lock.json' with { type: 'json' };
import { envVar } from '../src/core/brand.js';
import { defaultConfigDir } from '../src/core/index/local/models.js';
import {
  REQUIRED_MODEL_FILES,
  sha256File,
} from '../src/core/index/local/model-files.js';

/** Prints the `files` block for each model in models.lock.json from the local model cache. */
export async function hashModels(
  cacheDir: string,
  models: Record<string, { id: string; revision: string }> = lock,
): Promise<Record<string, { path: string; sha256: string }[]>> {
  const out: Record<string, { path: string; sha256: string }[]> = {};
  for (const [name, model] of Object.entries(models)) {
    const files: { path: string; sha256: string }[] = [];
    for (const file of [...REQUIRED_MODEL_FILES].sort()) {
      files.push({
        path: file,
        sha256: await sha256File(
          join(cacheDir, model.id, model.revision, file),
        ),
      });
    }
    out[name] = files;
  }
  return out;
}

// import.meta.main needs Node 22.18+; engines allows 22.13, where it would silently do nothing.
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: { 'config-dir': { type: 'string' } },
  });
  const configDir =
    values['config-dir'] ??
    process.env[envVar('CONFIG_DIR')] ??
    defaultConfigDir();
  console.log(
    JSON.stringify(await hashModels(resolve(configDir, 'models')), null, 2),
  );
}
