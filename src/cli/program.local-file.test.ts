import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import {
  makeFederalStylePdf,
  makeAmendmentHtml,
  makeCongressionalBillXml,
  makeSectionedText,
} from '../../tests/synth/index.js';
import { documentId } from '../core/fetch/index.js';
import { MockProvider } from '../core/llm/mock.js';
import { Registry } from '../core/registry.js';
import { createProgram } from './program.js';
import type { CliRuntime } from './runtime.js';
import type { Launcher } from '../server/launch.js';

let dir: string;
let runtime: CliRuntime;
let output: string;
let backend: MemoryBackend;
let provider: MockProvider;
const network = vi.fn(() =>
  Promise.reject(new Error('Local ingestion must not use the network')),
);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cli-local-file-'));
  output = '';
  network.mockClear();
  backend = new MemoryBackend();
  provider = new MockProvider();
  runtime = {
    backend,
    registry: new Registry(join(dir, 'config')),
    fetcher: network,
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    maxDocs: 5,
    retrievalMode: 'hybrid_rerank',
    port: 4317,
    answerProvider: provider,
    extractProvider: provider,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function run(args: string[], serve?: Launcher) {
  await createProgram({
    runtime: () => Promise.resolve(runtime),
    write: (text) => {
      output += text;
    },
    ...(serve ? { serve } : {}),
  }).parseAsync(args, { from: 'user' });
}

test.each(['pdf', 'xml', 'html', 'text'] as const)(
  'ingests synthetic %s bytes by path through the real parser and MemoryBackend',
  async (format) => {
    const sample =
      format === 'pdf'
        ? await makeFederalStylePdf()
        : format === 'xml'
          ? makeCongressionalBillXml()
          : format === 'html'
            ? makeAmendmentHtml()
            : makeSectionedText();
    // No format extension: content sniffing must drive parser selection.
    const path = join(dir, 'downloaded bill');
    await writeFile(path, sample.bytes);
    await run(['ingest', path]);
    expect(output).toContain(`Format: ${format}`);
    expect(output).toContain('Ingested: downloaded bill');
    expect(output).toMatch(/Embedding tokens: [1-9]\d*/);
    const [doc] = await runtime.registry.list();
    expect(doc).toMatchObject({
      docId: documentId(sample.bytes),
      label: 'downloaded bill',
      sourceUrl: 'file:///downloaded%20bill',
      format,
    });
    expect(doc!.sourceUrl).not.toContain(dir);
    expect(await backend.hasDocument(doc!.docId)).toBe(true);
    const { hits } = await backend.search({
      docId: doc!.docId,
      index: 'dense',
      query: 'grants',
      topK: 10,
    });
    expect(hits.length).toBeGreaterThan(0);
    output = '';
    await run(['list']);
    expect(output).toContain('downloaded bill');
    output = '';
    await run([
      'ask',
      'downloaded bill',
      format === 'html'
        ? 'What are the permit fees?'
        : 'What grants are available?',
    ]);
    expect(output).toContain('Citations:');
    expect(network).not.toHaveBeenCalled();
  },
);

test('unchanged content is a zero-token no-op; edits create a new document and label', async () => {
  const path = join(dir, 'bill.txt');
  await writeFile(path, makeSectionedText().bytes);
  await run(['ingest', relative(process.cwd(), path)]);
  const [original] = await runtime.registry.list();
  const upsert = vi.spyOn(backend, 'upsertChunks');
  const extract = vi.spyOn(provider, 'generateObject');
  output = '';
  await run(['ingest', pathToFileURL(path).href]);
  expect(output).toContain('Already ingested: bill.txt (reused, 0 tokens)');
  expect(upsert).not.toHaveBeenCalled();
  expect(extract).not.toHaveBeenCalled();
  expect(await runtime.registry.list()).toHaveLength(1);

  const changed = new TextEncoder().encode(
    'Section 1. Grants\nCounties may apply for new grants.',
  );
  await writeFile(path, changed);
  await run(['ingest', path]);
  const docs = await runtime.registry.list();
  expect(docs).toHaveLength(2);
  const next = docs.find((doc) => doc.docId !== original!.docId);
  expect(next?.docId).toBe(documentId(changed));
  expect(next?.label).toBe(`bill.txt (${documentId(changed).slice(0, 6)})`);
  expect(await backend.hasDocument(original!.docId)).toBe(true);
  expect(await backend.hasDocument(next!.docId)).toBe(true);
  expect(upsert).toHaveBeenCalledOnce();
  expect(extract).toHaveBeenCalledOnce();
  expect(network).not.toHaveBeenCalled();
});

test.each(['path', 'file URL'])(
  'the default command accepts a %s and hands off the document to serve',
  async (kind) => {
    const path = join(dir, 'bill #1.txt');
    const bytes = makeSectionedText().bytes;
    await writeFile(path, bytes);
    const serve = vi.fn<Launcher>(() => Promise.resolve());
    await run([kind === 'path' ? path : pathToFileURL(path).href], serve);
    expect(serve).toHaveBeenCalledWith(runtime, { publicMode: false });
    // The UI opens the most recently used document, which is the one just ingested.
    expect((await runtime.registry.list())[0]?.docId).toBe(documentId(bytes));
    expect(output).toContain('Ingested: bill #1.txt');
    expect(network).not.toHaveBeenCalled();
  },
);

test('--name overrides the filename', async () => {
  const path = join(dir, 'bill.xml');
  await writeFile(path, makeCongressionalBillXml().bytes);
  await run(['ingest', path, '--name', 'my bill']);
  expect((await runtime.registry.list())[0]?.label).toBe('my bill');
});

test('missing paths and directories are friendly CLI errors without network', async () => {
  await expect(run(['ingest', join(dir, 'missing.txt')])).rejects.toMatchObject(
    {
      userMessage: expect.stringContaining('could not be found') as string,
    },
  );
  await expect(run(['ingest', dir])).rejects.toMatchObject({
    userMessage: expect.stringContaining('directory') as string,
  });
  expect(await runtime.registry.list()).toEqual([]);
  expect(network).not.toHaveBeenCalled();
});
