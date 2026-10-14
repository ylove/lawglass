import { fetch, type Dispatcher, type Response } from 'undici';
import { AppError } from '../model/index.js';
import { prepareHtml, type PreparedHtml } from '../parse/html.js';
import {
  ParseBudget,
  readParseLimits,
  type ParseLimits,
} from '../parse/limits.js';
import { BRAND } from '../brand.js';
import {
  defaultCacheDir,
  DEFAULT_MAX_BYTES,
  documentId,
  readCache,
  writeCache,
} from './cache.js';
import {
  createPinnedDispatcher,
  defaultResolver,
  resolvePublicAddress,
  type ResolvedAddress,
  type Resolver,
} from './resolve.js';
import { sniffFormat, type SniffedFormat } from './sniff.js';
import { findCandidateLinks, isLikelyWrapper } from './wrapper.js';

export interface SafeFetchOptions {
  parseLimits?: ParseLimits | undefined;
  /** Re-read mutable official records while still caching the downloaded snapshot. */
  refresh?: boolean | undefined;
  /** Additional source policy, applied before DNS on every hop, including cached redirects. */
  validateUrl?: ((url: URL) => void) | undefined;
  /** Cancels DNS, redirects and body streaming without replacing the download deadline. */
  signal?: AbortSignal | undefined;
  resolver?: Resolver;
  /** Injected dispatchers belong to the caller; default agents are destroyed after each hop. */
  dispatcherFactory?: (
    url: URL,
    addresses: readonly ResolvedAddress[],
  ) => Dispatcher;
  /** Programmatic override; every hop must use one of these ports. */
  allowedPorts?: readonly number[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** The cache directory itself, rather than its configuration-directory parent. */
  cacheDir?: string;
  now?: () => Date;
}
export interface SafeFetchResult {
  preparedHtml?: PreparedHtml | undefined;
  docId: string;
  bytes: Uint8Array;
  finalUrl: string;
  contentType: string;
  format: SniffedFormat;
  fromCache: boolean;
}

function validateUrl(
  input: string,
  allowedPorts: readonly number[],
  base?: URL,
): URL {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new AppError('INVALID_INPUT');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new AppError('SSRF_BLOCKED');
  if (url.username || url.password) throw new AppError('INVALID_INPUT');
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  if (!allowedPorts.includes(port))
    throw new AppError(
      'SSRF_BLOCKED',
      `Port ${String(port)} is not allowed for document downloads.`,
    );
  url.hash = '';
  return url;
}

function makeResult(
  bytes: Uint8Array,
  finalUrl: string,
  contentType: string,
  fromCache: boolean,
  opts: SafeFetchOptions,
): SafeFetchResult {
  const format = sniffFormat(bytes, contentType, finalUrl);
  const limits = opts.parseLimits ?? readParseLimits();
  if (format !== 'pdf' && bytes.byteLength > limits.maxNonPdfBytes)
    throw new AppError('TOO_LARGE');
  let preparedHtml: PreparedHtml | undefined;
  if (format === 'html') {
    const budget = new ParseBudget({
      signal: opts.signal,
      timeoutMs: limits.timeoutMs,
    });
    preparedHtml = prepareHtml(
      bytes,
      { contentType, maxHtmlBytes: limits.maxHtmlBytes },
      budget,
    );
    if (isLikelyWrapper(preparedHtml.dom)) {
      throw new AppError('WRAPPER_PAGE', undefined, {
        details: { links: findCandidateLinks(preparedHtml.dom, finalUrl) },
      });
    }
    budget.check();
  }
  return {
    ...(preparedHtml ? { preparedHtml } : {}),
    docId: documentId(bytes),
    bytes,
    finalUrl,
    contentType,
    format,
    fromCache,
  };
}

async function readBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length.trim()) && Number(length) > maxBytes) {
    controller.abort();
    throw new AppError('TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        controller.abort();
        throw new AppError('TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Download a bounded document snapshot. Every network hop gets fresh validation and pinning. */
export async function safeFetch(
  input: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const allowedPorts = [...(opts.allowedPorts ?? [80, 443, 8080, 8443])];
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 0xffff_ffff ||
    !Number.isSafeInteger(maxRedirects) ||
    maxRedirects < 0 ||
    allowedPorts.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65535,
    )
  ) {
    throw new AppError('INVALID_INPUT');
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    deadline,
    controller.signal,
    ...(opts.signal ? [opts.signal] : []),
  ]);
  const resolver = opts.resolver ?? defaultResolver;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  try {
    const original = validateUrl(input, allowedPorts);
    opts.validateUrl?.(original);
    let url = original;
    let address = await resolvePublicAddress(url, resolver, signal);
    const cached = opts.refresh
      ? undefined
      : await readCache(original.href, cacheDir, maxBytes);
    if (cached) {
      const final = validateUrl(cached.finalUrl, allowedPorts);
      opts.validateUrl?.(final);
      if (final.href !== original.href)
        await resolvePublicAddress(final, resolver, signal);
      signal.throwIfAborted();
      return makeResult(
        cached.bytes,
        final.href,
        cached.contentType,
        true,
        opts,
      );
    }
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const dispatcher = (opts.dispatcherFactory ?? createPinnedDispatcher)(
        url,
        address,
      );
      try {
        const response = await fetch(url, {
          dispatcher,
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': `${BRAND.name}/${BRAND.version} (+${BRAND.repositoryUrl})`,
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location)
            throw new AppError('FETCH_FAILED', 'Redirect has no destination.');
          if (redirects >= maxRedirects)
            throw new AppError('TOO_MANY_REDIRECTS');
          url = validateUrl(location, allowedPorts, url);
          opts.validateUrl?.(url);
          address = await resolvePublicAddress(url, resolver, signal);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new AppError(
            'FETCH_FAILED',
            `HTTP status ${String(response.status)}.`,
          );
        }
        const bytes = await readBody(response, maxBytes, controller);
        const contentType = response.headers.get('content-type') ?? '';
        signal.throwIfAborted();
        const result = makeResult(bytes, url.href, contentType, false, opts);
        await writeCache(
          bytes,
          {
            url: original.href,
            finalUrl: url.href,
            contentType,
            fetchedAt: (opts.now ?? (() => new Date()))().toISOString(),
          },
          cacheDir,
        );
        return result;
      } finally {
        // Never retain sockets capable of connecting with an obsolete DNS validation.
        if (!opts.dispatcherFactory) await dispatcher.destroy();
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (deadline.aborted) throw new AppError('FETCH_TIMEOUT');
    // External errors can contain credentials; keep transport detail out of our errors.
    throw new AppError('FETCH_FAILED');
  }
}
