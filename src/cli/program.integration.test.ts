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
  // A valid chip id with no chip runner wired yet is a clear error, not a crash.
  await expect(run(['ask', 'g', '--chip', 'summary'])).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
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
  await run(['remove', 'g']);
  expect(output).toBe('Removed g\n');
  expect(await env.registry.list()).toEqual([]);
  expect(await env.backend.hasDocument(entry?.docId ?? '')).toBe(false);
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
  expect(serve).toHaveBeenCalledOnce();
  expect(output).toContain('Format: text');
});

test('the bare URL form explains how to continue without a server', async () => {
  await run(['https://example.gov/gardens.txt']);
  expect(output).toMatch(
    /web UI is not available yet.*ask [0-9a-f]{12} "<question>"/s,
  );
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
  }).parseAsync(args, { from: 'user' });
  expect(seen).toEqual(['local']);
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
