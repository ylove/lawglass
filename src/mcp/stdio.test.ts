import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { makeMcpEnv } from '../../tests/support/mcp-env.js';
import { makePipelineEnv } from '../../tests/support/pipeline-env.js';
import { createMcpServer, TOOL_NAMES } from './server.js';
import { claimStdout, serveStdio, type StdioProcess } from './stdio.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeProcess(): {
  proc: StdioProcess;
  real: string[];
  err: string[];
} {
  const real: string[] = [];
  const err: string[] = [];
  const sink = (into: string[]) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      into.push(String(chunk));
      const done = rest.find((r) => typeof r === 'function') as
        (() => void) | undefined;
      done?.();
      return true;
    }) as unknown as StdioProcess['stdout']['write'];
  return {
    real,
    err,
    proc: {
      stdin: new PassThrough(),
      stdout: { write: sink(real) },
      stderr: { write: sink(err) },
    },
  };
}

test('claimStdout gives the protocol the real stdout and sends every other write to stderr', async () => {
  const { proc, real, err } = fakeProcess();
  const target = { log: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const originalLog = target.log;
  const errorSpy = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  const claimed = claimStdout(proc, target);

  // Stray writes, by any route, never reach the real stdout.
  proc.stdout.write('stray text\n');
  target.log('console.log noise');
  target.info('console.info noise');
  target.debug('console.debug noise');
  expect(real).toEqual([]);
  expect(err).toEqual(['stray text\n']);
  expect(errorSpy).toHaveBeenCalledTimes(3);

  await new Promise<void>((resolve, reject) => {
    claimed.protocol.write('{"jsonrpc":"2.0"}\n', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  expect(real).toEqual(['{"jsonrpc":"2.0"}\n']);

  claimed.restore();
  proc.stdout.write('after restore\n');
  expect(real.at(-1)).toBe('after restore\n');
  expect(target.log).toBe(originalLog);
});

const rpc = (id: number, method: string, params: object = {}): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

test('serves JSON-RPC over the claimed stdout and stops when stdin ends', async () => {
  const env = await makePipelineEnv();
  const { server, shutdown } = createMcpServer(env.runtime);
  const stdin = new PassThrough();
  const lines: string[] = [];
  let buffered = '';
  const protocol = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        lines.push(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
      callback();
    },
  });
  const served = serveStdio(server, protocol, stdin, () => undefined);
  stdin.write(
    rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }),
  );
  stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );
  stdin.write(rpc(2, 'tools/list'));
  await vi.waitFor(() => {
    expect(lines).toHaveLength(2);
  });
  for (const line of lines)
    expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  const listed = JSON.parse(lines[1] ?? '{}') as {
    result: { tools: unknown[] };
  };
  expect(listed.result.tools).toHaveLength(4);

  stdin.end();
  await served;
  shutdown();
  await env.cleanup();
});

test('a termination signal closes the server', async () => {
  const env = await makePipelineEnv();
  const { server, shutdown } = createMcpServer(env.runtime);
  let signal: (() => void) | undefined;
  const served = serveStdio(
    server,
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
    new PassThrough(),
    (listener) => {
      signal = listener;
    },
  );
  await vi.waitFor(() => {
    expect(signal).toBeDefined();
  });
  signal?.();
  await served;
  shutdown();
  await env.cleanup();
});

test('shutdown aborts background ingests', async () => {
  let aborted = false;
  const m = await makeMcpEnv({
    server: { waitMs: 10 },
    runtime: (base) => ({
      ...base,
      fetcher: (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    }),
  });
  const started = await m.call(TOOL_NAMES.ingest, {
    url: 'https://example.gov/slow.html',
  });
  expect(started.json.status).toBe('ingesting');
  await m.close();
  expect(aborted).toBe(true);
});
