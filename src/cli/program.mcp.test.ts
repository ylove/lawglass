/** `mcp`, `search` and `get-section`: the CLI side of the agent interface. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeAmendmentHtml } from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { makeMcpEnv, type McpEnv } from '../../tests/support/mcp-env.js';
import { TOOL_NAMES } from '../mcp/server.js';
import { createProgram } from './program.js';
import type { RuntimeOptions } from './runtime.js';

let env: PipelineEnv;
let output: string;
let mcp: McpEnv | undefined;
beforeEach(async () => {
  output = '';
  env = await makePipelineEnv();
  env.serve(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
  await mcp?.close();
  mcp = undefined;
});

async function run(args: string[]): Promise<void> {
  await createProgram({
    runtime: () => Promise.resolve(env.runtime),
    write: (text) => {
      output += text;
    },
  }).parseAsync(args, { from: 'user' });
}

/** The random wrapper tag differs per response; everything else must be identical. */
const normalize = (text: string): unknown =>
  JSON.parse(text.replace(/bill_text_[0-9a-f]{16}/g, 'bill_text_TAG'));

test('the mcp command is listed and opens a local, key-free runtime for the launcher', async () => {
  let help = '';
  const program = createProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        help += text;
      },
    });
  expect(() => program.parse(['--help'], { from: 'user' })).toThrow();
  expect(help).toMatch(/\n {2}mcp\b/);
  expect(help).toMatch(/\n {2}search\b/);
  expect(help).toMatch(/\n {2}get-section\b/);

  const seen: RuntimeOptions[] = [];
  const launcher = vi.fn(async (open: () => Promise<unknown>) => {
    await open();
  });
  await createProgram({
    runtime: (options) => {
      seen.push(options);
      return Promise.resolve(env.runtime);
    },
    mcp: launcher,
  }).parseAsync(['mcp'], { from: 'user' });
  expect(launcher).toHaveBeenCalledOnce();
  expect(seen).toEqual([{ backend: 'local', needsLlm: false }]);
});

test('search --json prints the same JSON as the MCP search tool', async () => {
  await run(['ingest', 'https://example.gov/permit.html', '--name', 'permit']);
  const [entry] = await env.registry.list();
  const docId = entry?.docId ?? '';
  output = '';
  await run(['search', 'permit', 'permit fees', '--json']);
  expect(output.trim().split('\n')).toHaveLength(1); // compact: one line

  mcp = await makeMcpEnv();
  // The MCP env has its own store; ingest the same bytes there.
  mcp.env.serve(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
  await mcp.call(TOOL_NAMES.ingest, { url: 'https://example.gov/permit.html' });
  const viaMcp = await mcp.call(TOOL_NAMES.search, {
    doc: docId,
    query: 'permit fees',
  });
  // Labels differ (the CLI run named it), so compare after removing the label-derived cite.
  const strip = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replace(/"cite":"[^"]*"/g, '"cite":"X"'));
  expect(strip(normalize(output))).toEqual(strip(normalize(viaMcp.text)));
  expect(Object.keys(normalize(output) as object)).toEqual(
    Object.keys(viaMcp.json),
  );
});

test('get-section prints current and redline views as the MCP tool does', async () => {
  await run(['ingest', 'https://example.gov/permit.html', '--name', 'permit']);
  const [entry] = await env.registry.list();
  const docId = entry?.docId ?? '';

  mcp = await makeMcpEnv();
  mcp.env.serve(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
  await mcp.call(TOOL_NAMES.ingest, { url: 'https://example.gov/permit.html' });
  const strip = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replace(/"cite":"[^"]*"/g, '"cite":"X"'));

  output = '';
  await run(['get-section', docId.slice(0, 10), 'sec-1', '--json']);
  const current = await mcp.call(TOOL_NAMES.getSection, {
    doc: docId,
    section: 'sec-1',
  });
  expect(strip(normalize(output))).toEqual(strip(normalize(current.text)));

  output = '';
  await run(['get-section', 'permit', 'sec-1', '--view', 'redline', '--json']);
  const redline = await mcp.call(TOOL_NAMES.getSection, {
    doc: docId,
    section: 'sec-1',
    view: 'redline',
  });
  expect(strip(normalize(output))).toEqual(strip(normalize(redline.text)));
  expect(output).toContain('STRUCK');

  // Without --json the same JSON is pretty-printed.
  output = '';
  await run(['get-section', 'permit', 'sec-1']);
  expect(output.split('\n').length).toBeGreaterThan(5);
  expect(JSON.parse(output)).toHaveProperty('current_text');
});

test('search and get-section refuse unknown documents, sections and views', async () => {
  await run(['ingest', 'https://example.gov/permit.html', '--name', 'permit']);
  await expect(run(['search', 'missing', 'fees'])).rejects.toMatchObject({
    code: 'DOC_NOT_FOUND',
  });
  await expect(
    run(['get-section', 'permit', '../../etc/passwd']),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    run(['get-section', 'permit', 'sec-1', '--view', 'raw']),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
