import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makeAmendingBillPdf,
  makeAmendmentHtml,
  makeCongressionalBillXml,
  makeSectionedText,
} from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  stubPdfParser,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { writeHistory } from '../core/history/history-store.js';
import { AppError } from '../core/model/index.js';
import { createProgram, type CliDependencies } from './program.js';

let env: PipelineEnv;
let output: string;
beforeEach(async () => {
  output = '';
  const pdf = await makeAmendingBillPdf();
  env = await makePipelineEnv({ parsePdf: stubPdfParser(pdf) });
  env.serve('https://example.gov/s9001.xml', makeCongressionalBillXml());
  env.serve(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
  env.serve(
    'https://example.gov/gardens.txt',
    makeSectionedText(),
    'text/plain',
  );
  env.serve('https://example.gov/hb1.pdf', pdf, 'application/pdf');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

async function run(
  args: string[],
  extra: Partial<CliDependencies> = {},
): Promise<void> {
  await createProgram({
    runtime: () => Promise.resolve(env.runtime),
    write: (text) => {
      output += text;
    },
    ...extra,
  }).parseAsync(args, { from: 'user' });
}

test('ingest prints format, metadata, counts, spans, refs and token usage', async () => {
  await run(['ingest', 'https://example.gov/s9001.xml', '--name', 'garden']);
  expect(output).toContain('Ingested: garden');
  expect(output).toContain('Format: xml');
  expect(output).toMatch(/Bill number: .*9001/);
  expect(output).toMatch(/Sections: \d+/);
  expect(output).toMatch(/Chunks: \d+ \(.*definition \d+/);
  expect(output).toContain('Amendment spans: 0 deleted, 0 inserted');
  expect(output).toMatch(/Unresolved external references: \d+/);
  expect(output).toMatch(/Embedding tokens: [1-9]\d*/);
});

test('ingest reports deleted and inserted span counts for HTML', async () => {
  await run(['ingest', 'https://example.gov/permit.html']);
  expect(output).toContain('Format: html');
  expect(output).toContain('Amendment spans: 4 deleted, 3 inserted');
});

test('re-ingest prints the reuse message and spends nothing', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt']);
  output = '';
  await run(['ingest', 'https://example.gov/gardens.txt']);
  expect(output).toContain('reused, 0 tokens');
  expect(output).toContain('Embedding tokens: 0');
});

test('ask streams the answer and resolves XML citations to section-only form', async () => {
  await run(['ingest', 'https://example.gov/s9001.xml', '--name', 'garden']);
  output = '';
  await run(['ask', 'garden', 'What are the garden grants?']);
  expect(output).toMatch(/\[S:sec-\d+/);
  expect(output).toContain('Citations:');
  expect(output).toMatch(/\n {2}Sec\. \d+\S* {2}\[S:sec-/);
  expect(output).not.toMatch(/Sec\. \d+[^\n]*, p\. /);
});

test('ask on a PDF resolves citations with page and lines', async () => {
  await run(['ingest', 'https://example.gov/hb1.pdf', '--name', 'ohio']);
  output = '';
  await run(['ask', 'ohio', 'What does adjusted gross income mean?']);
  expect(output).toMatch(/Sec\. 5747\.01[^\n]*, p\. 1, lines? \d+/);
});

test('ask accepts a doc-id prefix', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt']);
  const [entry] = await env.registry.list();
  output = '';
  await run([
    'ask',
    (entry?.docId ?? '').slice(0, 10),
    'grants for shared gardens',
  ]);
  expect(output).toContain('Citations:');
});

test('ask validates its arguments and chips', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  await expect(run(['ask', 'g'])).rejects.toBeInstanceOf(AppError);
  await expect(
    run(['ask', 'g', 'q', '--chip', 'summary']),
  ).rejects.toBeInstanceOf(AppError);
  await expect(run(['ask', 'g', '--chip', 'nonsense'])).rejects.toMatchObject({
    userMessage: expect.stringContaining('Unknown chip') as string,
  });
  // Chips are wired by default: the metadata-only sponsors chip answers without a model.
  output = '';
  await run(['ask', 'g', '--chip', 'sponsors']);
  expect(output).toMatch(/sponsor/i);
  // history is served too; this document has no sidecar, so it says so without a model call.
  output = '';
  await run(['ask', 'g', '--chip', 'history']);
  expect(output).toContain("Legislative history isn't available");
  // Record text is escaped for the web renderer; the terminal shows it literally.
  const [gEntry] = await env.registry.list();
  await writeHistory(env.registry.configDir, String(gEntry?.docId), {
    versions: [],
    actions: [{ date: '2026-01-02', text: 'Cut *limit* [S:x] a\\b' }],
    amendments: [],
    sources: [],
  });
  output = '';
  await run(['ask', 'g', '--chip', 'history']);
  expect(output).toContain('Cut *limit* [S:x] a\\b');
  expect(output).not.toContain('\\*');
  await expect(run(['ask', 'missing', 'q'])).rejects.toMatchObject({
    code: 'DOC_NOT_FOUND',
  });
});

test('list and remove', async () => {
  await run(['list']);
  expect(output).toBe('No documents ingested yet.\n');
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  output = '';
  await run(['list']);
  expect(output).toMatch(/^g {2}\| {2}[0-9a-f]{12} {2}\| {2}text/);
  const [entry] = await env.registry.list();
  output = '';
  const embedReady = vi.spyOn(env.embedder, 'ensureReady');
  const rerankReady = vi.spyOn(env.reranker, 'ensureReady');
  await run(['remove', 'g']);
  expect(embedReady).not.toHaveBeenCalled();
  expect(rerankReady).not.toHaveBeenCalled();
  expect(output).toBe('Removed g\n');
  expect(await env.registry.list()).toEqual([]);
  expect(await env.backend.hasDocument(entry?.docId ?? '')).toBe(false);
});

test('remove preserves the registry entry when backend deletion fails', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  const remove = vi
    .spyOn(env.backend, 'deleteDocument')
    .mockRejectedValue(new AppError('BACKEND_UNAVAILABLE'));
  await expect(run(['remove', 'g'])).rejects.toMatchObject({
    code: 'BACKEND_UNAVAILABLE',
  });
  expect(remove).toHaveBeenCalledOnce();
  expect(await env.registry.list()).toHaveLength(1);
});

test('a wrapper page lists the candidate links in the error', async () => {
  const links = [
    { url: 'https://example.gov/bill.pdf', text: 'Full text', format: 'pdf' },
  ];
  env.runtime.fetcher = () =>
    Promise.reject(
      new AppError('WRAPPER_PAGE', undefined, { details: { links } }),
    );
  const error = await run(['ingest', 'https://example.gov/page']).catch(
    (e: unknown) => e,
  );
  expect(error).toMatchObject({ code: 'WRAPPER_PAGE' });
  const message = (error as AppError).userMessage;
  expect(message).toContain('https://example.gov/bill.pdf');
  expect(message).toContain('Full text');
  expect(message).toContain('Run again');
});

test('the bare URL form ingests, then hands off to serve when available', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await run(['https://example.gov/gardens.txt'], { serve });
  expect(serve).toHaveBeenCalledWith(env.runtime, {
    publicMode: false,
    docId: expect.any(String) as string,
  });
  expect(output).toContain('Format: text');
});

test('serve passes port, host and public mode to the launcher', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await run(['serve', '--port', '4999', '--host', '0.0.0.0', '--public'], {
    serve,
  });
  expect(serve).toHaveBeenCalledWith(env.runtime, {
    publicMode: true,
    port: 4999,
    host: '0.0.0.0',
  });
});

test('serve defaults to a private local server', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await run(['serve'], { serve });
  expect(serve).toHaveBeenCalledWith(env.runtime, {
    publicMode: false,
    port: undefined,
    host: undefined,
  });
});

test('the bare URL form passes --no-open to the launcher', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await run(['https://example.gov/gardens.txt', '--no-open'], { serve });
  expect(serve).toHaveBeenCalledWith(env.runtime, {
    publicMode: false,
    docId: expect.any(String) as string,
    noOpen: true,
  });
});

test('serve passes --no-open to the launcher', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await run(['serve', '--no-open'], { serve });
  expect(serve).toHaveBeenCalledWith(env.runtime, {
    publicMode: false,
    port: undefined,
    host: undefined,
    noOpen: true,
  });
});

test('serve rejects a port that is not a number', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await expect(
    run(['serve', '--port', 'abc'], { serve }),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(serve).not.toHaveBeenCalled();
});

test.each([
  [
    'ingest',
    ['ingest', 'https://example.gov/gardens.txt', '--backend', 'local'],
  ],
  ['ask', ['ask', 'g', 'garden grants', '--backend', 'local']],
  ['list', ['list', '--backend', 'local']],
  ['remove', ['remove', 'g', '--backend', 'local']],
  ['bare url', ['https://example.gov/gardens.txt', '--backend', 'local']],
])('%s passes --backend to the runtime', async (_name, args) => {
  const seen: unknown[] = [];
  await createProgram({
    runtime: (options) => {
      seen.push(options.backend);
      return Promise.resolve(env.runtime);
    },
    write: () => undefined,
  }).parseAsync(['ingest', 'https://example.gov/gardens.txt', '--name', 'g'], {
    from: 'user',
  });
  seen.length = 0;
  await createProgram({
    runtime: (options) => {
      seen.push(options.backend);
      return Promise.resolve(env.runtime);
    },
    write: () => undefined,
    serve: () => Promise.resolve(),
  }).parseAsync(args, { from: 'user' });
  expect(seen).toEqual(['local']);
});

test('the root command hands the ingested document to the launcher so the browser opens it', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await run(['https://example.gov/gardens.txt'], { serve });
  const [entry] = await env.registry.list();
  expect(serve).toHaveBeenCalledWith(
    env.runtime,
    expect.objectContaining({ docId: entry!.docId }),
  );
});

test('ask prints text from other chips and the model unchanged (no unescaping)', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  const modelish = {
    ...env.runtime,
    chips: (
      _chip: unknown,
      _docId: unknown,
      _ctx: unknown,
      opts: { onToken?: ((t: string) => void) | undefined },
    ) => {
      opts.onToken?.('Saved to C:\\*.txt');
      return Promise.resolve({
        answer: {
          text: 'Saved to C:\\*.txt',
          citations: [],
          invalidCitations: [],
          warnings: [],
          declined: false,
          readingGrade: null,
          provider: 'mock' as const,
          model: 'm',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        hits: [],
        backendUsage: {
          embedTokens: 0,
          rerankUnits: 0,
          readUnits: 0,
          writeUnits: 0,
        },
        mode: 'none' as const,
      });
    },
  };
  output = '';
  await createProgram({
    runtime: () => Promise.resolve(modelish),
    write: (t) => {
      output += t;
    },
  }).parseAsync(['ask', 'g', '--chip', 'summary'], { from: 'user' });
  expect(output).toContain('Saved to C:\\*.txt');
});

test('ask prints "In simpler words:" and the final text when the answer was rewritten', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  const streamed = 'A very long and tangled first draft [S:sec-1].';
  const rewritten = 'A short plain version [S:sec-1].';
  const result = (simplified: boolean) => ({
    answer: {
      text: simplified ? rewritten : streamed,
      citations: [],
      invalidCitations: [],
      warnings: [],
      declined: false,
      readingGrade: 5,
      provider: 'mock' as const,
      model: 'm',
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(simplified && { simplified: true }),
    },
    hits: [],
    backendUsage: {
      embedTokens: 0,
      rerankUnits: 0,
      readUnits: 0,
      writeUnits: 0,
    },
    mode: 'whole' as const,
  });
  for (const simplified of [true, false]) {
    const runtime = {
      ...env.runtime,
      chips: (
        _c: unknown,
        _d: unknown,
        _x: unknown,
        opts: { onToken?: ((t: string) => void) | undefined },
      ) => {
        opts.onToken?.(streamed);
        return Promise.resolve(result(simplified));
      },
    };
    output = '';
    await createProgram({
      runtime: () => Promise.resolve(runtime),
      write: (t) => {
        output += t;
      },
    }).parseAsync(['ask', 'g', '--chip', 'summary'], { from: 'user' });
    expect(output).toContain(streamed);
    if (simplified) expect(output).toContain(`In simpler words:\n${rewritten}`);
    else expect(output).not.toContain('In simpler words:');
  }
});

test('ask prints the final text when sentences about the excerpts were removed, and ignores marker-only differences', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  const make = (streamed: string, final: string) => ({
    ...env.runtime,
    chips: (
      _c: unknown,
      _d: unknown,
      _x: unknown,
      opts: { onToken?: ((t: string) => void) | undefined },
    ) => {
      opts.onToken?.(streamed);
      return Promise.resolve({
        answer: {
          text: final,
          citations: [],
          invalidCitations: [],
          warnings: [],
          declined: false,
          readingGrade: 5,
          provider: 'mock' as const,
          model: 'm',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        hits: [],
        backendUsage: {
          embedTokens: 0,
          rerankUnits: 0,
          readUnits: 0,
          writeUnits: 0,
        },
        mode: 'whole' as const,
      });
    },
  });
  const runWith = async (streamed: string, final: string) => {
    output = '';
    await createProgram({
      runtime: () => Promise.resolve(make(streamed, final)),
      write: (t) => {
        output += t;
      },
    }).parseAsync(['ask', 'g', '--chip', 'summary'], { from: 'user' });
  };
  await runWith(
    "Grants go to towns [S:a]. The excerpts don't show more.",
    'Grants go to towns [S:a].',
  );
  expect(output).toContain('Final answer:\nGrants go to towns [S:a].');
  // An invalid marker stripped from the final text is not worth printing twice.
  await runWith(
    'Grants go to towns [S:a] [S:bad].',
    'Grants go to towns [S:a].',
  );
  expect(output).not.toContain('Final answer:');
});

test('ask --chip does not require an LLM key until a model call is made', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  const needs: boolean[] = [];
  const keyless = {
    ...env.runtime,
    get answerProvider(): never {
      throw new AppError('MISSING_KEY');
    },
    chips: () =>
      Promise.resolve({
        answer: {
          text: 'No sponsors stated.',
          citations: [],
          invalidCitations: [],
          warnings: [],
          declined: false,
          readingGrade: null,
          provider: 'none',
          model: 'none',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        hits: [],
        backendUsage: {
          embedTokens: 0,
          rerankUnits: 0,
          readUnits: 0,
          writeUnits: 0,
        },
        mode: 'none' as const,
      }),
  };
  output = '';
  await createProgram({
    runtime: (o) => {
      needs.push(o.needsLlm);
      return Promise.resolve(keyless);
    },
    write: (t) => {
      output += t;
    },
  }).parseAsync(['ask', 'g', '--chip', 'sponsors'], { from: 'user' });
  expect(needs).toEqual([false]);
  // A freeform question needs the key up front, before retrieval spends anything.
  await expect(
    createProgram({
      runtime: () => Promise.resolve(keyless),
      write: () => undefined,
    }).parseAsync(['ask', 'g', 'a question'], { from: 'user' }),
  ).rejects.toMatchObject({ code: 'MISSING_KEY' });
});

test('remove refuses to drop an entry that belongs to another backend', async () => {
  await run(['ingest', 'https://example.gov/gardens.txt', '--name', 'g']);
  const foreign = Object.create(env.backend, {
    kind: { value: 'pinecone' },
  }) as typeof env.backend;
  const del = vi.spyOn(env.backend, 'deleteDocument');
  await expect(
    run(['remove', 'g'], {
      runtime: () => Promise.resolve({ ...env.runtime, backend: foreign }),
    }),
  ).rejects.toMatchObject({
    userMessage: expect.stringContaining('--backend local') as string,
  });
  expect(del).not.toHaveBeenCalled();
  expect(await env.registry.list()).toHaveLength(1);
});

test('terminal escapes from document text never reach the output', async () => {
  const links = [
    {
      url: 'https://example.gov/bill.pdf',
      text: '\u001b]8;;https://evil.example/\u0007Full text\u001b]8;;\u0007',
      format: 'pdf',
    },
  ];
  env.runtime.fetcher = () =>
    Promise.reject(
      new AppError('WRAPPER_PAGE', undefined, { details: { links } }),
    );
  const error = await run(['ingest', 'https://example.gov/page']).catch(
    (e: unknown) => e,
  );
  const message = (error as AppError).userMessage;
  expect(message).toContain('Full text');
  expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  expect(message).not.toContain('evil.example');
});

test.each(['serve', 'https://example.gov/gardens.txt'])(
  '%s refuses network binds before ingest or launch unless --public is explicit',
  async (action) => {
    const serve = vi.fn(() => Promise.resolve());
    for (const host of ['0.0.0.0', '::', '10.0.0.1', '192.168.1.1']) {
      await expect(
        run([action, '--host', host], { serve }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        userMessage: expect.stringContaining(
          'Local mode has no authentication',
        ) as string,
      });
    }
    expect(serve).not.toHaveBeenCalled();
    expect(env.fetches).toEqual([]);
  },
);

test.each(['serve', 'https://example.gov/gardens.txt'])(
  '%s rejects hostnames and malformed IP literals even with --public',
  async (action) => {
    const serve = vi.fn(() => Promise.resolve());
    for (const host of ['evil.example', 'localhost.evil', '[::1]', '127.1']) {
      await expect(
        run([action, '--host', host, '--public'], { serve }),
      ).rejects.toMatchObject({
        userMessage: '--host must be an IP literal or localhost.',
      });
    }
    expect(serve).not.toHaveBeenCalled();
    expect(env.fetches).toEqual([]);
  },
);

test('bare URL passes explicit public bind and port to the launcher', async () => {
  const serve = vi.fn(() => Promise.resolve());
  await run(
    [
      'https://example.gov/gardens.txt',
      '--host',
      '0.0.0.0',
      '--public',
      '--port',
      '4999',
    ],
    { serve },
  );
  expect(serve).toHaveBeenCalledWith(env.runtime, {
    publicMode: true,
    docId: expect.any(String) as string,
    host: '0.0.0.0',
    port: 4999,
  });
});

test.each([
  '127.0.0.2',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
  'localhost',
])('serve accepts local bind %s', async (host) => {
  const serve = vi.fn(() => Promise.resolve());
  await run(['serve', '--host', host], { serve });
  expect(serve).toHaveBeenCalledWith(env.runtime, {
    publicMode: false,
    host,
    port: undefined,
  });
});

test('ask --json emits the answer with its context mode and no streamed prose or footer', async () => {
  await run(['ingest', 'https://example.gov/s9001.xml', '--name', 'garden']);
  output = '';
  await run(['ask', 'garden', 'What are the garden grants?', '--json']);
  const value = JSON.parse(output) as { context: string; text: string };
  expect(value.context).toBe('whole');
  expect(value.text).toContain('[S:sec-');
  expect(output).not.toContain('Citations:');
});
