import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPinnedDispatcher,
  createPinnedLookup,
  defaultResolver,
  resolvePublicAddress,
  withAbort,
  type Resolver,
} from './resolve.js';

const publicAddress = { address: '8.8.8.8', family: 4 as const };
afterEach(() => {
  vi.restoreAllMocks();
});
describe('resolution and pinning', () => {
  it('uses lookup with all records', async () => {
    // Only the all:true overload is exercised by this test.
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockImplementation((() =>
        Promise.resolve([publicAddress])) as unknown as typeof dns.lookup);
    expect(await defaultResolver('example.gov')).toEqual([publicAddress]);
    expect(lookup).toHaveBeenCalledWith('example.gov', { all: true });
    lookup.mockImplementation((() =>
      Promise.resolve([
        { address: '2606:4700::1111', family: 6 },
      ])) as unknown as typeof dns.lookup);
    expect(await defaultResolver('example.gov')).toEqual([
      { address: '2606:4700::1111', family: 6 },
    ]);
  });
  it('rejects mixed public/private records and malformed answers', async () => {
    for (const answers of [
      [publicAddress, { address: '10.0.0.1', family: 4 as const }],
      [{ address: 'bad', family: 4 as const }],
      [{ address: '8.8.8.8', family: 6 as const }],
    ]) {
      await expect(
        resolvePublicAddress(new URL('https://example.gov'), () =>
          Promise.resolve(answers),
        ),
      ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    }
    await expect(
      resolvePublicAddress(new URL('https://example.gov'), () =>
        Promise.resolve([]),
      ),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });
  it('pins the first public answer without a second resolution', async () => {
    const resolver = vi
      .fn<Resolver>()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const selected = await resolvePublicAddress(
      new URL('https://example.gov'),
      resolver,
    );
    const lookup = createPinnedLookup(selected);
    selected.address = '10.0.0.1';
    await new Promise<void>((resolve) => {
      lookup('example.gov', {}, (error, address, family) => {
        expect(error).toBeNull();
        expect(address).toBe('8.8.8.8');
        expect(family).toBe(4);
        resolve();
      });
    });
    lookup('example.gov', { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([publicAddress]);
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    // The attacker's subsequent answer would be rejected if used for a new hop.
    await expect(
      resolvePublicAddress(new URL('https://example.gov'), resolver),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
  ])('checks normalized literals %s without DNS', async (url) => {
    const resolver = vi.fn<Resolver>();
    await expect(
      resolvePublicAddress(new URL(url), resolver),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    expect(resolver).not.toHaveBeenCalled();
  });
  it('copies resolver answers and supports public IPv6 literals', async () => {
    const mutable = { ...publicAddress };
    const selected = await resolvePublicAddress(
      new URL('https://example.gov'),
      () => Promise.resolve([mutable]),
    );
    mutable.address = '127.0.0.1';
    expect(selected).toEqual(publicAddress);
    expect(
      await resolvePublicAddress(new URL('https://[2606:4700::1111]/')),
    ).toEqual({ address: '2606:4700::1111', family: 6 });
  });
  it('constructs agents for hostname and literal URLs without connecting', async () => {
    for (const url of ['https://example.gov', 'https://8.8.8.8']) {
      const agent = createPinnedDispatcher(new URL(url), publicAddress);
      expect(agent.destroyed).toBe(false);
      await agent.destroy();
    }
  });
  it('bounds hanging DNS and handles already aborted signals', async () => {
    const controller = new AbortController();
    const result = resolvePublicAddress(
      new URL('https://example.gov'),
      () =>
        new Promise(() => {
          /* Deliberately never resolves. */
        }),
      controller.signal,
    );
    controller.abort(new Error('deadline'));
    await expect(result).rejects.toThrow('deadline');
    await expect(
      withAbort(Promise.resolve('done'), controller.signal),
    ).rejects.toThrow('deadline');
    await expect(
      withAbort(
        Promise.reject(new Error('late DNS failure')),
        controller.signal,
      ),
    ).rejects.toThrow('deadline');
    const nonError = new AbortController();
    nonError.abort('stopped');
    await expect(
      withAbort(Promise.resolve('done'), nonError.signal),
    ).rejects.toThrow('Operation aborted.');
  });
});
