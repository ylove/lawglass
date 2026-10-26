/**
 * Canary-key audit (#185). Every provider gets an obvious fake key that is easy to grep for.
 * The injected SDK transports fail the way real ones sometimes do: with errors, causes and
 * HTTP bodies that echo the key. Whatever happens, the key must not reach anything a user,
 * a log or an SSE client can see.
 */
import { inspect } from 'node:util';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSseEvents } from '../../src/web/sse.js';
import { createProgram } from '../../src/cli/program.js';
import type { CliRuntime } from '../../src/cli/runtime.js';
import { resolveConfig, redact } from '../../src/core/config.js';
import { envVar } from '../../src/core/brand.js';
import { PineconeBackend } from '../../src/core/index/index.js';
import { AnthropicProvider } from '../../src/core/llm/anthropic.js';
import { GoogleProvider } from '../../src/core/llm/google.js';
import { OpenAIProvider } from '../../src/core/llm/openai.js';
import {
  AppError,
  AskEvent,
  IngestEvent,
  type LlmProvider,
} from '../../src/core/model/index.js';
import { createSessionTestApp as createApp } from '../support/session-app.js';
import { makePipelineEnv, type PipelineEnv } from '../support/pipeline-env.js';
import { makeSectionedText } from '../synth/index.js';

const KEYS = {
  anthropic: 'sk-ant-api03-CANARY-anthropic-0001',
  openai: 'sk-CANARY-openai-0002',
  google: 'AIzaCANARY-google-0003',
  pinecone: 'pcsk_CANARY-pinecone-0004',
} as const;
const CANARIES = Object.values(KEYS);
const GARDENS = 'https://example.gov/gardens.txt';
const OTHER = 'https://example.gov/other.txt';

/** The spec-level assertion: no canary, and no 12+ character piece of one, anywhere. */
function expectNoCanary(label: string, text: string): void {
  for (const key of CANARIES) {
    expect(text, `${label} leaked ${key}`).not.toContain(key);
    // A truncated or re-wrapped key is still a leak.
    expect(text, `${label} leaked part of ${key}`).not.toContain(
      key.slice(0, 14),
    );
  }
  expect(text, label).not.toMatch(/CANARY/);
}

/** Everything an error can show: message, userMessage, stack, cause chain, JSON, inspect. */
function describeError(error: unknown): string {
  const parts = [inspect(error, { depth: 20, showHidden: true })];
  try {
    parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error)));
  } catch {
    // Circular structures: inspect above already covers them.
  }
  if (error instanceof Error) parts.push(String(error), error.stack ?? '');
  return parts.join('\n');
}

type TransportMode = 'throws' | 'http-401';
/** How many requests reached a failing transport; proves each failure path really ran. */
let transportCalls = 0;
/** A fetch whose failures embed the key: in the thrown message, its cause, and the body. */
function leakyFetch(key: string, mode: TransportMode): typeof fetch {
  return (input, init) => {
    transportCalls++;
    const request = new Request(input, init);
    const echo = `Incorrect API key provided: ${key}. Authorization: Bearer ${key}`;
    if (mode === 'throws')
      return Promise.reject(
        new Error(`connect failed for ${request.url} using ${key}`, {
          cause: new Error(echo),
        }),
      );
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error: { message: echo, type: 'invalid_request_error' },
          type: 'error',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
  };
}

const providers: Record<
  'anthropic' | 'openai' | 'google',
  (mode: TransportMode) => LlmProvider
> = {
  anthropic: (mode) =>
    new AnthropicProvider(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: KEYS.anthropic,
      },
      { fetch: leakyFetch(KEYS.anthropic, mode) },
    ),
  openai: (mode) =>
    new OpenAIProvider(
      { provider: 'openai', model: 'gpt-4.1', apiKey: KEYS.openai },
      { fetch: leakyFetch(KEYS.openai, mode) },
    ),
  google: (mode) =>
    new GoogleProvider(
      { provider: 'google', model: 'gemini-2.5-flash', apiKey: KEYS.google },
      { fetch: leakyFetch(KEYS.google, mode) },
    ),
};

/** A Pinecone client that fails the way the SDK does: errors that echo the Api-Key header. */
function leakyPinecone(): PineconeBackend {
  const fail = (): never => {
    throw Object.assign(
      new Error(`401 Unauthorized. Api-Key: ${KEYS.pinecone}`, {
        cause: { headers: { 'Api-Key': KEYS.pinecone } },
      }),
      { name: 'PineconeAuthorizationError', status: 401 },
    );
  };
  const client = {
    indexes: { createForModel: fail, describe: fail },
    index: fail,
    inference: { rerank: fail },
  };
  return new PineconeBackend({
    client: client, // Test double: only the failing surface is needed.
    apiKey: KEYS.pinecone,
  });
}

// The entrypoint builds its own program; route it to the runtime under test. Hoisted so the
// mock can read it, and the program module itself stays the real one.
const runtimeForEntrypoint = vi.hoisted(() => ({
  current: undefined as CliRuntime | undefined,
}));
vi.mock('../../src/cli/program.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/cli/program.js')>();
  return {
    ...actual,
    createProgram: (deps: Parameters<typeof actual.createProgram>[0]) =>
      actual.createProgram(
        deps ?? {
          runtime: () => Promise.resolve(runtimeForEntrypoint.current!),
        },
      ),
  };
});

let env: PipelineEnv;
let captured: string[];
beforeEach(async () => {
  captured = [];
  transportCalls = 0;
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      captured.push(
        `${name}: ${args.map((a) => inspect(a, { depth: 10 })).join(' ')}`,
      );
    };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, method).mockImplementation(record(`console.${method}`));
  for (const stream of ['stdout', 'stderr'] as const)
    vi.spyOn(process[stream], 'write').mockImplementation((chunk: unknown) => {
      captured.push(`${stream}: ${String(chunk)}`);
      return true;
    });
  vi.stubEnv('ANTHROPIC_API_KEY', KEYS.anthropic);
  vi.stubEnv('OPENAI_API_KEY', KEYS.openai);
  vi.stubEnv('GOOGLE_API_KEY', KEYS.google);
  vi.stubEnv('PINECONE_API_KEY', KEYS.pinecone);
  env = await makePipelineEnv();
  env.serve(GARDENS, makeSectionedText(), 'text/plain');
  // Different bytes: identical content would hit the already-indexed (reuse) path and skip extraction.
  env.serve(
    OTHER,
    {
      bytes: new TextEncoder().encode(
        `${new TextDecoder().decode(makeSectionedText().bytes)}\nSEC. 900. Appendix\nA second, different document.\n`,
      ),
    },
    'text/plain',
  );
});
afterEach(async () => {
  expectNoCanary('stderr and structured logs', captured.join('\n'));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await env.cleanup();
});

function runtimeWith(overrides: Partial<CliRuntime>): CliRuntime {
  return { ...env.runtime, ...overrides };
}
async function ingestedDocId(): Promise<string> {
  // Ingest with the healthy mock so there is a document to ask about.
  const app = createApp(env.runtime, { localOnly: false });
  const res = await app.request('/api/ingest', post({ url: GARDENS }));
  await collect(readSseEvents(res, IngestEvent));
  const [entry] = await env.registry.list();
  return String(entry?.docId);
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function sseText(res: Response): Promise<string> {
  return res.text();
}

describe('web server: SSE and JSON bodies', () => {
  describe.each(Object.keys(providers) as (keyof typeof providers)[])(
    '%s provider',
    (name) => {
      it.each(['throws', 'http-401'] as const)(
        'ask and summary fail without leaking the key (%s)',
        async (mode) => {
          const docId = await ingestedDocId();
          const provider = providers[name](mode);
          const app: Hono = createApp(
            runtimeWith({
              answerProvider: provider,
              extractProvider: provider,
            }),
            { localOnly: false },
          );

          const ask = await app.request(
            `/api/docs/${docId}/ask`,
            post({ question: 'What do the grants cover?' }),
          );
          const askBody = await sseText(ask);
          // Not vacuous: the failure really surfaced as a user-safe error event.
          expect(askBody).toContain('"type":"error"');
          expect(askBody).toMatch(/PROVIDER_ERROR/);
          expectNoCanary(`${name}/${mode} ask SSE`, askBody);

          // Summary generation runs in the background: poll until it reaches its terminal
          // state (a failed run reports `disabled`) and only then audit.
          const before = transportCalls;
          const summaryBodies: string[] = [];
          let status = 'pending';
          for (let i = 0; i < 500 && status === 'pending'; i++) {
            const res = await app.request(`/api/docs/${docId}/summary`);
            const text = await res.text();
            summaryBodies.push(`${String(res.status)} ${text}`);
            status = (JSON.parse(text) as { status: string }).status;
            if (status === 'pending')
              await new Promise((r) => setTimeout(r, 10));
          }
          expect(status, 'summary must settle').toBe('disabled');
          expect(
            transportCalls,
            'summary used the failing transport',
          ).toBeGreaterThan(before);
          expectNoCanary(`${name}/${mode} summary`, summaryBodies.join('\n'));

          // A different document, so ingest extracts metadata through the failing transport.
          const callsBeforeIngest = transportCalls;
          const ingest = await app.request('/api/ingest', post({ url: OTHER }));
          const ingestBody = await sseText(ingest);
          expectNoCanary(`${name}/${mode} ingest SSE`, ingestBody);
          expect(ingestBody).toContain('"type":"done"');
          expect(
            transportCalls,
            'extraction used the failing transport',
          ).toBeGreaterThan(callsBeforeIngest);
          const done = ingestBody
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map(
              (line) =>
                JSON.parse(line.slice(6)) as {
                  type: string;
                  doc?: { docId: string };
                },
            )
            .find((event) => event.type === 'done');
          const detail = await app.request(
            `/api/docs/${String(done?.doc?.docId)}`,
          );
          const detailText = await detail.text();
          expect(detailText).toContain('could not be read automatically');
          expectNoCanary(`${name}/${mode} doc detail`, detailText);
          expectNoCanary(`${name}/${mode} console`, captured.join('\n'));
        },
      );
    },
  );

  it.each(['0', '100000'])(
    'does not echo a key carried by a non-AppError from the fetcher or backend (budget %s)',
    async (budget) => {
      vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), budget);
      const docId = await ingestedDocId();
      const leak = (): never => {
        throw new Error(`boom ${CANARIES.join(' ')}`, {
          cause: new Error(KEYS.openai),
        });
      };
      const app = createApp(
        runtimeWith({
          fetcher: leak,
          backend: new Proxy(env.backend, {
            get(target, property, receiver) {
              return property === 'search' ||
                property === 'getChunks' ||
                property === 'upsertChunks'
                ? leak
                : (Reflect.get(target, property, receiver) as unknown);
            },
          }),
        }),
        { localOnly: false },
      );
      const ingest = await sseText(
        await app.request('/api/ingest', post({ url: OTHER })),
      );
      expect(ingest).toContain('"type":"error"');
      expectNoCanary('ingest SSE', ingest);
      const ask = await sseText(
        await app.request(
          `/api/docs/${docId}/ask`,
          post({ question: 'Grants?' }),
        ),
      );
      expect(ask).toContain('"type":"error"');
      expectNoCanary('ask SSE', ask);
      for await (const event of readSseEvents(
        await app.request(
          `/api/docs/${docId}/ask`,
          post({ question: 'Again?' }),
        ),
        AskEvent,
      ))
        expectNoCanary('parsed event', JSON.stringify(event));
    },
  );

  it('keeps a failing Pinecone backend (key in headers and cause) out of the response', async () => {
    const docId = await ingestedDocId();
    const app = createApp(runtimeWith({ backend: leakyPinecone() }), {
      localOnly: false,
    });
    expectNoCanary(
      'pinecone ingest',
      await sseText(await app.request('/api/ingest', post({ url: OTHER }))),
    );
    expectNoCanary(
      'pinecone ask',
      await sseText(
        await app.request(
          `/api/docs/${docId}/ask`,
          post({ question: 'Grants?' }),
        ),
      ),
    );
    expectNoCanary('pinecone console', captured.join('\n'));
  });
});

describe('provider adapters: thrown errors', () => {
  it.each(Object.keys(providers) as (keyof typeof providers)[])(
    '%s drops message, cause and stack content that echoes the key',
    async (name) => {
      for (const mode of ['throws', 'http-401'] as const) {
        const provider = providers[name](mode);
        const request = {
          system: 's',
          messages: [{ role: 'user' as const, content: 'q' }],
          maxTokens: 10,
        };
        const failures: unknown[] = [];
        try {
          await collect(provider.streamText(request));
        } catch (error) {
          failures.push(error);
        }
        await provider
          .generateObject({
            system: 's',
            prompt: 'p',
            schemaName: 'x',
            schema: (await import('zod')).z.object({}),
            maxTokens: 10,
          })
          .catch((error: unknown) => failures.push(error));
        expect(failures).toHaveLength(2);
        for (const error of failures)
          expectNoCanary(`${name}/${mode}`, describeError(error));
      }
    },
  );
});

describe('CLI paths', () => {
  describe.each(Object.keys(providers) as (keyof typeof providers)[])(
    '%s provider',
    (name) => {
      it('ingest, ask and the entrypoint error printer never show a key', async () => {
        const provider = providers[name]('http-401');
        const runtime = runtimeWith({
          answerProvider: provider,
          extractProvider: provider,
        });
        let stdout = '';
        const run = (args: string[]) =>
          createProgram({
            runtime: () => Promise.resolve(runtime),
            write: (text) => {
              stdout += text;
            },
          }).parseAsync(args, { from: 'user' });

        // Extraction failures are warnings, so ingest succeeds; the transport must have run.
        await run(['ingest', GARDENS, '--name', 'garden']);
        expect(
          transportCalls,
          'extraction used the failing transport',
        ).toBeGreaterThan(0);
        const asked = await run(['ask', 'garden', 'What is funded?']).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(
          asked,
          'ask must fail for this test to mean anything',
        ).toBeInstanceOf(AppError);
        captured.push(describeError(asked));

        // The real entrypoint and printer, in this module graph so `instanceof AppError`
        // agrees. The query string makes the entrypoint's top-level code run again.
        runtimeForEntrypoint.current = runtime;
        const argv = process.argv;
        const exitCode = process.exitCode;
        process.argv = ['node', 'cli', 'ask', 'garden', 'What is funded?'];
        try {
          const entrypoint = `../../src/cli/index.ts?provider=${name}`;
          await import(/* @vite-ignore */ entrypoint);
          expect(process.exitCode).toBe(1);
        } finally {
          process.argv = argv;
          process.exitCode = exitCode;
        }
        const printed = captured.filter((line) =>
          line.startsWith('console.error'),
        );
        // The specific user message, not the generic fallback.
        expect(printed.join('\n')).toContain((asked as AppError).userMessage);
        expect(printed.join('\n')).not.toContain('could not be completed');
        expectNoCanary('cli stdout', stdout);
        expectNoCanary('cli output', captured.join('\n'));
      });
    },
  );
});

describe('configuration', () => {
  it('rejects invalid settings without echoing the keys beside them', async () => {
    const error = await resolveConfig({
      homeDir: env.dir,
      env: {
        ANTHROPIC_API_KEY: KEYS.anthropic,
        OPENAI_API_KEY: KEYS.openai,
        GOOGLE_API_KEY: KEYS.google,
        PINECONE_API_KEY: KEYS.pinecone,
        [envVar('PORT')]: 'not-a-port',
      },
      isTTY: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expectNoCanary('config error', describeError(error));
  });

  it('redact masks every key field', () => {
    const redacted = redact({
      anthropicApiKey: KEYS.anthropic,
      openaiApiKey: KEYS.openai,
      googleApiKey: KEYS.google,
      pineconeApiKey: KEYS.pinecone,
    });
    const text = JSON.stringify(redacted);
    for (const key of CANARIES) expect(text).not.toContain(key);
    expect(text).not.toMatch(/CANARY/);
  });
});

it('private invite exchange and refusal/error logs never expose invite or provider canaries', async () => {
  const { createApp: rawApp } = await import('../../src/server/app.js');
  const accessKey = KEYS.anthropic;
  const app = rawApp(env.runtime, { privateMode: true, accessKey });
  const exchange = await app.request(`http://preview.example/?k=${accessKey}`);
  expect(exchange.status).toBe(302);
  expectNoCanary('private cookie', exchange.headers.get('set-cookie') ?? '');
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0] ?? '';
  const denied = await app.request(`/api/docs?k=${KEYS.openai}`);
  expect(denied.status).toBe(401);
  vi.spyOn(env.registry, 'list').mockImplementation(() => {
    const failure = new Error(CANARIES.join(' '));
    failure.name = KEYS.google;
    throw failure;
  });
  const failure = await app.request('/api/docs', { headers: { cookie } });
  expect(failure.status).toBe(500);
  expectNoCanary('private API failure', await failure.text());
  const stderr = captured
    .filter((line) => line.startsWith('stderr:'))
    .join('\n');
  expect(stderr).toContain('internal_error');
  expect(stderr).toContain('UNAUTHORIZED');
  expectNoCanary('private stderr', stderr);
});
