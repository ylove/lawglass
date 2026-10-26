import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_MODEL_FILES } from '../src/core/index/local/model-files.js';
import { hashModels } from './hash-models.js';

describe('hashModels', () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('hashes every required file of each model from the cache layout', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hash-models-'));
    const base = join(dir, 'o/m', 'rev');
    await mkdir(join(base, 'onnx'), { recursive: true });
    for (const file of REQUIRED_MODEL_FILES)
      await writeFile(join(base, file), file);
    const out = await hashModels(dir, { m: { id: 'o/m', revision: 'rev' } });
    expect(out.m?.find((entry) => entry.path === 'config.json')?.sha256).toBe(
      createHash('sha256').update('config.json').digest('hex'),
    );
    expect(out.m).toHaveLength(REQUIRED_MODEL_FILES.length);
  });

  it('fails when a file is missing from the cache', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hash-models-'));
    await expect(
      hashModels(dir, { m: { id: 'o/m', revision: 'rev' } }),
    ).rejects.toThrow();
  });
});
