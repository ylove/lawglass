import dns from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { AppError } from '../model/index.js';
import { isBlockedAddress } from './ip.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;
export const defaultResolver: Resolver = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

/** Bound DNS as well as transport; an injected resolver need not implement cancellation. */
export async function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error ? reason : new Error('Operation aborted.'),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    // Race even an already-aborted signal so a later work rejection is still handled.
    return await Promise.race([aborted, work]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function resolvePublicAddress(
  url: URL,
  resolver: Resolver = defaultResolver,
  signal?: AbortSignal,
): Promise<ResolvedAddress> {
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const work = family
    ? Promise.resolve([{ address: hostname, family: family as 4 | 6 }])
    : resolver(hostname);
  const addresses = await (signal ? withAbort(work, signal) : work);
  if (!addresses.length)
    throw new AppError('FETCH_FAILED', 'DNS returned no addresses.');
  if (
    addresses.some(
      (a) => isBlockedAddress(a.address) || isIP(a.address) !== a.family,
    )
  ) {
    throw new AppError('SSRF_BLOCKED');
  }
  // Copy so the resolver cannot mutate the pinned answer after validation.
  const first = addresses[0];
  if (!first) throw new AppError('FETCH_FAILED');
  return { ...first };
}

/** This lookup never consults DNS, even if Node requests all addresses. */
export function createPinnedLookup(address: ResolvedAddress): LookupFunction {
  const pinned = { ...address };
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ ...pinned }]);
    else callback(null, pinned.address, pinned.family);
  };
}

export function createPinnedDispatcher(
  url: URL,
  address: ResolvedAddress,
): Agent {
  // The request URL retains Host; TLS retains the hostname for SNI and certificate checks.
  return new Agent({
    connect: {
      // safeFetch's single deadline covers DNS, redirects, and the entire body.
      timeout: 0,
      lookup: createPinnedLookup(address),
      servername: isIP(url.hostname.replace(/^\[|\]$/g, ''))
        ? undefined
        : url.hostname,
      autoSelectFamily: false,
    },
  });
}
