import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, buildConnector } from 'undici';
import { afterEach, expect, test, vi } from 'vitest';
import { envVar } from '../core/brand.js';
import { getConfigDir } from '../core/config.js';
import { defaultCacheDir } from '../core/fetch/index.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import { createRuntimeFrom } from './runtime.js';

let dispatcher: Agent | undefined;
// Fake only DNS and the pinned connection destination. The runtime fetcher, safeFetch,
// undici transport and streaming body reader all run as shipped, against loopback.
vi.mock('../core/fetch/resolve.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/fetch/resolve.js')>();
  return {
    ...actual,
    defaultResolver: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
    createPinnedDispatcher: () => dispatcher,
  };
});

let home: string | undefined;
let downloadServer: http.Server | undefined;
afterEach(async () => {
  await dispatcher?.destroy();
  if (downloadServer) {
    downloadServer.closeAllConnections();
    await new Promise<void>((resolve) =>
      downloadServer?.close(() => {
        resolve();
      }),
    );
  }
  if (home) await rm(home, { recursive: true, force: true });
});

test('disconnecting an ingest stops a streaming download through the production runtime', async () => {
  home = await mkdtemp(join(tmpdir(), 'runtime-fetch-'));
  let connectionClosed = false;
  let started: () => void = () => undefined;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  downloadServer = http.createServer((_req, res) => {
    res.on('close', () => {
      connectionClosed = true;
    });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('SECTION 1. A document whose download never finishes.\n');
    started();
  });
  await new Promise<void>((resolve) =>
    downloadServer?.listen(0, '127.0.0.1', resolve),
  );
  const address = downloadServer.address();
  if (!address || typeof address === 'string')
    throw new Error('No download port');
  const connector = buildConnector({});
  dispatcher = new Agent({
    connect: (options, callback) => {
      connector(
        {
          ...options,
          hostname: '127.0.0.1',
          host: '127.0.0.1',
          port: String(address.port),
        },
        callback,
      );
    },
  });
  const destroyed = vi.spyOn(dispatcher, 'destroy');
  const runtime = await createRuntimeFrom({
    homeDir: home,
    env: { [envVar('LLM_PROVIDER')]: 'mock' },
    isTTY: false,
  })({ needsLlm: true });
  const fetcher = vi.spyOn(runtime, 'fetcher');
  const app = createApp(runtime);
  const response = await app.request('http://localhost/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.gov:8080/bill.txt' }),
  });
  await downloading;
  expect(fetcher).toHaveBeenCalledOnce();
  const download: unknown = fetcher.mock.results[0]?.value;
  const stopped = expect(download).rejects.toMatchObject({
    code: 'FETCH_FAILED',
  });
  await response.body?.cancel();
  await stopped;
  await vi.waitFor(() => {
    expect(connectionClosed).toBe(true);
  });
  expect(destroyed).toHaveBeenCalled();
  expect(await runtime.registry.list()).toEqual([]);
  await expect(
    readdir(defaultCacheDir(getConfigDir(home))),
  ).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
