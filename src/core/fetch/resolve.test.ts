import dns from 'node:dns/promises';
import { Socket } from 'node:net';
import { buildConnector } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPinnedConnector,
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
  it('pins validated answers without a second resolution', async () => {
    const resolver = vi
      .fn<Resolver>()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const selected = await resolvePublicAddress(
      new URL('https://example.gov'),
      resolver,
    );
    const lookup = createPinnedLookup(selected[0]!);
    selected[0]!.address = '10.0.0.1';
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
    expect(selected).toEqual([publicAddress]);
    expect(
      await resolvePublicAddress(new URL('https://[2606:4700::1111]/')),
    ).toEqual([{ address: '2606:4700::1111', family: 6 }]);
  });
  it('constructs agents for hostname and literal URLs without connecting', async () => {
    for (const url of ['https://example.gov', 'https://8.8.8.8']) {
      const agent = createPinnedDispatcher(new URL(url), [publicAddress]);
      expect(agent.destroyed).toBe(false);
      await agent.destroy();
    }
  });
  it('falls back from validated IPv6 to IPv4 in order, preserving the TLS hostname', async () => {
    const ipv6 = { address: '2606:4700::1111', family: 6 as const };
    const answers = [
      ipv6,
      { ...publicAddress },
      { address: '1.1.1.1', family: 4 as const },
    ];
    const resolver = vi.fn<Resolver>().mockResolvedValue(answers);
    const selected = await resolvePublicAddress(
      new URL('https://example.gov'),
      resolver,
    );
    const socket = new Socket();
    const failed = vi.fn<buildConnector.connector>((_options, callback) => {
      callback(new Error('IPv6 unavailable'), null);
    });
    const succeeded = vi.fn<buildConnector.connector>((_options, callback) => {
      callback(null, socket);
    });
    const factory = vi
      .fn<typeof buildConnector>()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(succeeded)
      .mockReturnValueOnce(vi.fn());
    const connect = createPinnedConnector(
      new URL('https://example.gov'),
      selected,
      factory,
    );
    answers[0]!.address = '::1';
    selected[1]!.address = '127.0.0.1';
    const options = {
      hostname: 'example.gov',
      protocol: 'https:',
      port: '443',
    };
    const callback = vi.fn<buildConnector.Callback>();
    connect(options, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, socket);
    expect(failed).toHaveBeenCalledWith(options, expect.any(Function));
    expect(succeeded).toHaveBeenCalledWith(options, expect.any(Function));
    expect(failed.mock.invocationCallOrder[0]).toBeLessThan(
      succeeded.mock.invocationCallOrder[0]!,
    );
    expect(factory.mock.results[2]!.value).not.toHaveBeenCalled();
    for (const [index, address] of [
      { address: '2606:4700::1111', family: 6 },
      publicAddress,
      { address: '1.1.1.1', family: 4 },
    ].entries()) {
      const config = factory.mock.calls[index]![0];
      expect(config).toMatchObject({
        family: address.family,
        servername: 'example.gov',
        autoSelectFamily: false,
      });
      if (!config || !('lookup' in config) || !config.lookup)
        throw new Error('Missing pinned lookup');
      config.lookup('attacker.invalid', { all: true }, (error, pinned) => {
        expect(error).toBeNull();
        expect(pinned).toEqual([address]);
      });
    }
    expect(resolver).toHaveBeenCalledTimes(1);
    socket.destroy();
  });
  it('reports failure only after exhausting pinned addresses and rejects an empty list', () => {
    const error = new Error('unreachable');
    const attempt = vi.fn<buildConnector.connector>((_options, callback) => {
      callback(error, null);
    });
    const factory = vi.fn<typeof buildConnector>().mockReturnValue(attempt);
    const connect = createPinnedConnector(
      new URL('http://example.gov'),
      [publicAddress, { address: '1.1.1.1', family: 4 }],
      factory,
    );
    const callback = vi.fn<buildConnector.Callback>();
    connect(
      { hostname: 'example.gov', protocol: 'http:', port: '80' },
      callback,
    );
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledExactlyOnceWith(error, null);
    expect(() =>
      createPinnedConnector(new URL('http://example.gov'), []),
    ).toThrow('No pinned addresses.');
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
