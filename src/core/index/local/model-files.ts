import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../model/index.js';

/**
 * Integrity checks for the local model files.
 *
 * `models.lock.json` pins a Hugging Face revision, but a revision alone does not protect against a
 * tampered cache or CDN, and transformers.js downloads bypass our SSRF-guarded fetch. So the lock
 * also carries a SHA-256 per file. We fetch missing files ourselves (from the pinned revision),
 * check every file against the lock, and only then let transformers.js load from the cache.
 */

export interface LockedModel {
  id: string;
  revision: string;
  /**
   * Each file's path (as laid out in the cache) and lowercase hex SHA-256. A list rather than a
   * path-keyed map: secret scanners read `"tokenizer.json": "<hex>"` as a leaked token.
   */
  files: readonly { readonly path: string; readonly sha256: string }[];
}

/** The files transformers.js reads for these q8 models. */
export const REQUIRED_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
] as const;

export type FileFetcher = (
  url: string,
  signal?: AbortSignal,
) => Promise<Response>;

export interface VerifyOptions {
  cacheDir: string;
  allowRemote: boolean;
  /** Injected so tests never touch the network. */
  fetchFile?: FileFetcher;
  signal?: AbortSignal;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function modelFileUrl(model: LockedModel, file: string): string {
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${model.id}/resolve/${model.revision}/${path}`;
}

/** A relative path that cannot escape the model directory. */
function assertSafeRelativePath(file: string): void {
  if (
    file === '' ||
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new AppError('INVALID_INPUT', `Unsafe model file path: ${file}`);
  }
}

function mismatch(model: LockedModel, file: string): AppError {
  return new AppError(
    'BACKEND_UNAVAILABLE',
    `Model file ${model.id}/${file} failed its SHA-256 check and was deleted. Re-run to download it again; if this keeps happening, do not use these files.`,
  );
}

async function download(
  model: LockedModel,
  file: string,
  target: string,
  fetchFile: FileFetcher,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetchFile(modelFileUrl(model, file), signal);
  if (!response.ok || !response.body) {
    throw new AppError(
      'BACKEND_UNAVAILABLE',
      `Could not download model file ${model.id}/${file} (HTTP ${String(response.status)}).`,
    );
  }
  await mkdir(dirname(target), { recursive: true });
  // Write to a temp name so a partial download is never mistaken for a cached file.
  const partial = `${target}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    const actual = await sha256File(partial);
    // Throw before the rename: an unverified file must never appear at its final path.
    if (actual !== expectedHash(model, file)) throw mismatch(model, file);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

function expectedHash(model: LockedModel, file: string): string | undefined {
  return model.files.find((entry) => entry.path === file)?.sha256;
}

/**
 * Make sure every locked file is present in the cache and matches its hash.
 * A mismatching file is deleted and an AppError is thrown. Missing files are downloaded
 * (when remote access is allowed) and checked before they are moved into place.
 */
export async function ensureVerifiedModelFiles(
  model: LockedModel,
  options: VerifyOptions,
): Promise<void> {
  const fetchFile: FileFetcher =
    options.fetchFile ??
    ((url, signal) => fetch(url, signal ? { signal } : {}));
  for (const { path: file, sha256: expected } of model.files) {
    assertSafeRelativePath(file);
    if (!SHA256_HEX.test(expected)) {
      throw new AppError(
        'INVALID_INPUT',
        `models.lock.json has an invalid SHA-256 for ${model.id}/${file}.`,
      );
    }
    options.signal?.throwIfAborted();
    const target = join(options.cacheDir, model.id, model.revision, file);
    let actual: string | undefined;
    try {
      actual = await sha256File(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (actual === undefined) {
      // Offline: leave it to the loader, which fails with its own clear error.
      if (options.allowRemote) {
        await download(model, file, target, fetchFile, options.signal);
      }
      continue;
    }
    if (actual !== expected) {
      await rm(target, { force: true });
      throw mismatch(model, file);
    }
  }
}
