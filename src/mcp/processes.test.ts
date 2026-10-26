/** Real child processes: stdout purity, the shipped `mcp` command, and a two-process ingest race. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LocalBackend } from '../core/index/index.js';
import { Registry } from '../core/registry.js';
import {
  FakeEmbedder,
  FakeReranker,
} from '../../tests/contracts/fake-local-models.js';
import { TOOL_NAMES } from './server.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  options: {
    input?: string;
    env?: Record<string, string>;
    /** Close stdin once this many lines have arrived on stdout (the client hangs up). */
    responses?: number;
  } = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split('\n').filter((line) => line.trim() !== '');
      if (options.responses !== undefined && lines.length >= options.responses)
        child.stdin.end();
    });
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr += chunk.toString('utf8')),
    );
    // A hung child must fail this test, not the whole run.
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(watchdog);
      resolve({ code, stdout, stderr });
    });
    if (options.responses === undefined) child.stdin.end(options.input ?? '');
    else child.stdin.write(options.input ?? '');
  });
}

const rpc = (id: number, method: string, params: object = {}): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
const initialize = (): string =>
  rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  }) +
  `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`;

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-proc-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a noisy process still writes only JSON-RPC to stdout; the noise lands on stderr', async () => {
  const result = await run(['tests/support/mcp-noisy-child.ts'], {
    input:
      initialize() +
      rpc(2, 'tools/list') +
      rpc(3, 'tools/call', {
        name: TOOL_NAMES.ingest,
        arguments: { url: 'https://example.gov/permit.html' },
      }) +
      rpc(4, 'tools/call', {
        name: TOOL_NAMES.outline,
        arguments: { doc: 'a'.repeat(64) },
      }),
    responses: 4,
  });
  expect(result.code).toBe(0);
  const messages = jsonLines(result.stdout);
  expect(messages.length).toBeGreaterThanOrEqual(2);
  for (const message of messages) {
    expect(message.jsonrpc).toBe('2.0');
    expect('id' in message || 'method' in message).toBe(true);
  }
  expect(result.stdout).not.toContain('NOISE');
  expect(result.stderr).toContain('NOISE console.log');
  expect(result.stderr).toContain('NOISE console.info');
  expect(result.stderr).toContain('NOISE console.debug');
  expect(result.stderr).toContain('NOISE process.stdout.write');
}, 60_000);

test('the shipped `mcp` command speaks only protocol on stdout and refuses an internal URL', async () => {
  const result = await run(['src/cli/index.ts', 'mcp'], {
    env: { HOME: dir, USERPROFILE: dir },
    input:
      initialize() +
      rpc(2, 'tools/list') +
      rpc(3, 'tools/call', {
        name: TOOL_NAMES.ingest,
        arguments: { url: 'http://169.254.169.254/latest/meta-data/' },
      }) +
      rpc(4, 'tools/call', {
        name: TOOL_NAMES.outline,
        arguments: { doc: 'a'.repeat(64) },
      }) +
      rpc(5, 'tools/call', {
        name: TOOL_NAMES.ingest,
        arguments: { url: '/etc/passwd' },
      }),
    responses: 5,
  });
  expect(result.code).toBe(0);
  const messages = jsonLines(result.stdout);
  for (const message of messages) expect(message.jsonrpc).toBe('2.0');
  const byId = new Map(messages.map((m) => [m.id, m]));
  const payload = (id: number): { error?: { code: string } } => {
    const text = (
      (byId.get(id)?.result as { content: { text: string }[] }).content[0] as {
        text: string;
      }
    ).text;
    return JSON.parse(text) as { error?: { code: string } };
  };
  expect((byId.get(2)?.result as { tools: unknown[] }).tools).toHaveLength(4);
  expect(payload(3).error?.code).toBe('SSRF_BLOCKED');
  expect(payload(4).error?.code).toBe('NOT_INGESTED');
  expect(payload(5).error?.code).toBe('INVALID_INPUT');
}, 60_000);

test('two server processes ingesting the same document at once end with one document', async () => {
  const [a, b] = await Promise.all([
    run(['tests/support/mcp-ingest-child.ts', dir]),
    run(['tests/support/mcp-ingest-child.ts', dir]),
  ]);
  // stderr rides along in the message so a failure on a slow runner explains itself.
  expect(a.code, a.stderr).toBe(0);
  expect(b.code, b.stderr).toBe(0);
  const docs = [a, b].map((r) => {
    const text = JSON.parse(r.stdout.trim()) as string;
    const payload = JSON.parse(text) as {
      status: string;
      doc: { doc_id: string };
    };
    expect(
      payload.status,
      `Child payload: ${JSON.stringify(payload)}\n${r.stderr}`,
    ).toBe('ready');
    return payload.doc.doc_id;
  });
  expect(docs[0]).toBe(docs[1]);
  const entries = await new Registry(join(dir, 'config')).list();
  expect(entries).toHaveLength(1);
  const backend = new LocalBackend({
    root: join(dir, 'store'),
    embedder: new FakeEmbedder(),
    reranker: new FakeReranker(),
  });
  await expect(backend.hasDocument(docs[0] ?? '')).resolves.toBe(true);
}, 60_000);
