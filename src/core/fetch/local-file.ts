import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError } from '../model/index.js';
import { DEFAULT_MAX_BYTES, documentId } from './cache.js';
import type { SafeFetchResult } from './safe-fetch.js';
import { sniffFormat } from './sniff.js';

export interface LocalFileOptions {
  maxBytes?: number;
  signal?: AbortSignal | undefined;
}

/** CLI-only input: read a regular file snapshot, without a URL cache or network access. */
export async function readLocalFile(
  input: string,
  opts: LocalFileOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!input || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new AppError('INVALID_INPUT');
  let path: string;
  try {
    if (/^file:/i.test(input)) {
      const url = new URL(input);
      // Windows also accepts remote file hosts; local ingestion must never read a network share.
      if (url.hostname && url.hostname !== 'localhost')
        throw new AppError('INVALID_INPUT');
      path = fileURLToPath(url);
    } else {
      path = resolve(input);
    }
  } catch {
    throw new AppError('INVALID_INPUT', undefined, {
      userMessage: 'That file URL is not a valid local file path.',
    });
  }
  opts.signal?.throwIfAborted();
  try {
    const info = await stat(path);
    if (!info.isFile())
      throw new AppError('INVALID_INPUT', undefined, {
        userMessage: info.isDirectory()
          ? 'That path is a directory. Choose a PDF, XML, HTML, or text file.'
          : 'That path is not a regular file. Choose a PDF, XML, HTML, or text file.',
      });
    if (info.size > maxBytes) throw new AppError('TOO_LARGE');
    // Nonblocking open prevents a file replaced with a FIFO from hanging before fstat.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile())
        throw new AppError('INVALID_INPUT', undefined, {
          userMessage: 'That path is not a regular file.',
        });
      if (opened.size > maxBytes) throw new AppError('TOO_LARGE');
      const chunks: Buffer[] = [];
      let total = 0;
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
      for (;;) {
        opts.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, maxBytes - total + 1),
          null,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
        // Check while reading too: the file can grow after either stat.
        if (total > maxBytes) throw new AppError('TOO_LARGE');
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const bytes = Buffer.concat(chunks, total);
      const finalUrl = pathToFileURL(path).href;
      return {
        bytes,
        docId: documentId(bytes),
        finalUrl,
        contentType: '',
        format: sniffFormat(bytes, '', finalUrl),
        fromCache: false,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof AppError || opts.signal?.aborted) throw error;
    const code = error instanceof Error && 'code' in error ? error.code : '';
    throw new AppError('INVALID_INPUT', undefined, {
      userMessage:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? 'That file could not be found. Check the path and try again.'
          : 'That file could not be read. Check its permissions and try again.',
    });
  }
}
