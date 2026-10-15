import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_LOCK } from './models.js';
import {
  ensureVerifiedModelFiles,
  modelFileUrl,
  sha256File,
  type LockedModel,
} from './model-files.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// Fake files stand in for the real weights, so no network and no 30 MB fixtures.
function fakeModel(contents: Record<string, string>): LockedModel {
  return {
    id: 'Org/fake-model',
    revision: 'rev123',
    files: Object.entries(contents).map(([path, text]) => ({
      path,
      sha256: sha(text),
    })),
  };
}

describe('model file hashes', () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'model-files-'));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });
  const pathOf = (model: LockedModel, file: string) =>
    join(cacheDir, model.id, model.revision, file);
  async function seed(model: LockedModel, contents: Record<string, string>) {
    for (const [file, text] of Object.entries(contents)) {
      await mkdir(join(pathOf(model, file), '..'), { recursive: true });
      await writeFile(pathOf(model, file), text);
    }
  }

  it('accepts cached files that match and does not fetch', async () => {
    const contents = { 'config.json': 'a', 'onnx/model.onnx': 'weights' };
    const model = fakeModel(contents);
    await seed(model, contents);
    const fetchFile = vi.fn();
    await ensureVerifiedModelFiles(model, {
      cacheDir,
      allowRemote: true,
      fetchFile,
    });
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('deletes a tampered cached file and fails clearly', async () => {
    const model = fakeModel({ 'config.json': 'good', 'tokenizer.json': 'tok' });
    await seed(model, { 'config.json': 'EVIL', 'tokenizer.json': 'tok' });
    await expect(
      ensureVerifiedModelFiles(model, { cacheDir, allowRemote: false }),
    ).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: expect.stringContaining('Org/fake-model/config.json') as string,
    });
    await expect(readFile(pathOf(model, 'config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('downloads a missing file from the pinned revision, verifies, then stores it', async () => {
    const model = fakeModel({ 'onnx/model.onnx': 'weights' });
    const fetchFile = vi.fn(() => Promise.resolve(new Response('weights')));
    await ensureVerifiedModelFiles(model, {
      cacheDir,
      allowRemote: true,
      fetchFile,
    });
    expect(fetchFile).toHaveBeenCalledWith(
      'https://huggingface.co/Org/fake-model/resolve/rev123/onnx/model.onnx',
      expect.any(AbortSignal),
    );
    expect(await readFile(pathOf(model, 'onnx/model.onnx'), 'utf8')).toBe(
      'weights',
    );
    expect(await sha256File(pathOf(model, 'onnx/model.onnx'))).toBe(
      sha('weights'),
    );
  });

  it('rejects a bad download without leaving any file behind', async () => {
    const model = fakeModel({ 'config.json': 'expected' });
    const fetchFile = () => Promise.resolve(new Response('substituted'));
    await expect(
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        fetchFile,
      }),
    ).rejects.toThrow(/SHA-256/);
    const dir = join(cacheDir, model.id, model.revision);
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails on HTTP errors and empty bodies', async () => {
    const model = fakeModel({ 'config.json': 'x' });
    await expect(
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        fetchFile: () => Promise.resolve(new Response('no', { status: 404 })),
      }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        fetchFile: () => Promise.resolve(new Response(null, { status: 200 })),
      }),
    ).rejects.toThrow(/Could not download/);
  });

  it('skips missing files when offline so the loader reports them', async () => {
    const model = fakeModel({ 'config.json': 'x' });
    const fetchFile = vi.fn();
    await ensureVerifiedModelFiles(model, {
      cacheDir,
      allowRemote: false,
      fetchFile,
    });
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('rejects unsafe paths and malformed hashes in the lock', async () => {
    for (const file of ['../escape', '/abs', 'a//b', 'a\\b', '']) {
      await expect(
        ensureVerifiedModelFiles(
          {
            id: 'o/m',
            revision: 'r',
            files: [{ path: file, sha256: sha('x') }],
          },
          { cacheDir, allowRemote: false },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(
      ensureVerifiedModelFiles(
        {
          id: 'o/m',
          revision: 'r',
          files: [{ path: 'config.json', sha256: 'not-a-hash' }],
        },
        { cacheDir, allowRemote: false },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('stops when aborted', async () => {
    const model = fakeModel({ 'config.json': 'x' });
    await expect(
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it('passes unexpected read errors through', async () => {
    const model = fakeModel({ 'config.json': 'x' });
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    await mkdir(pathOf(model, 'config.json'), { recursive: true });
    await expect(
      ensureVerifiedModelFiles(model, { cacheDir, allowRemote: false }),
    ).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('url-encodes path segments', () => {
    expect(
      modelFileUrl({ id: 'a/b', revision: 'r', files: [] }, 'x y/z.json'),
    ).toBe('https://huggingface.co/a/b/resolve/r/x%20y/z.json');
  });

  it('locks a valid sha256 for every required file of both shipped models', () => {
    for (const model of [MODEL_LOCK.embedding, MODEL_LOCK.reranker]) {
      expect(model.files.map((entry) => entry.path).sort()).toEqual([
        'config.json',
        'onnx/model_quantized.onnx',
        'tokenizer.json',
        'tokenizer_config.json',
      ]);
      for (const { sha256: hash } of model.files) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('stops a download that exceeds the size cap and leaves nothing behind', async () => {
    const model = fakeModel({ 'config.json': 'x' });
    await expect(
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        maxBytes: 10,
        fetchFile: () => Promise.resolve(new Response('y'.repeat(100))),
      }),
    ).rejects.toThrow(/larger than the expected 10 bytes/);
    expect(await readdir(join(cacheDir, model.id, model.revision))).toEqual([]);
  });

  it('derives the size cap from downloadBytes when not overridden', async () => {
    const model = { ...fakeModel({ 'config.json': 'x' }), downloadBytes: 1 };
    // 1 byte * 1.1 slack rounds up to 2 bytes.
    await expect(
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        fetchFile: () => Promise.resolve(new Response('abc')),
      }),
    ).rejects.toThrow(/larger than the expected 2 bytes/);
  });

  it('times out a stalled download', async () => {
    const model = fakeModel({ 'config.json': 'x' });
    const stalled = (_url: string, signal?: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    await expect(
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        timeoutMs: 20,
        fetchFile: stalled,
      }),
    ).rejects.toThrow();
  });

  it('uses distinct temp files so concurrent first runs do not collide', async () => {
    const model = fakeModel({ 'config.json': 'same' });
    const run = () =>
      ensureVerifiedModelFiles(model, {
        cacheDir,
        allowRemote: true,
        fetchFile: () => Promise.resolve(new Response('same')),
      });
    await Promise.all([run(), run(), run()]);
    expect(await readFile(pathOf(model, 'config.json'), 'utf8')).toBe('same');
    expect(await readdir(join(cacheDir, model.id, model.revision))).toEqual([
      'config.json',
    ]);
  });
});
