/**
 * Child process for the stdout-purity test: a real stdio MCP server (fakes behind it) whose
 * process is deliberately noisy. Run with `node --import tsx`.
 */
import { createMcpServer } from '../../src/mcp/server.js';
import { claimStdout, serveStdio } from '../../src/mcp/stdio.js';
import { makeAmendmentHtml } from '../synth/index.js';
import { makePipelineEnv } from './pipeline-env.js';

const { protocol } = claimStdout();
// Everything below would corrupt the protocol stream if it reached stdout.
console.log('NOISE console.log');
console.info('NOISE console.info');
console.debug('NOISE console.debug');
process.stdout.write('NOISE process.stdout.write\n');

const env = await makePipelineEnv();
env.serve('https://example.gov/permit.html', makeAmendmentHtml(), 'text/html');
const { server, shutdown } = createMcpServer(env.runtime);
// A dependency that logs while work is under way.
const originalFetcher = env.runtime.fetcher;
env.runtime.fetcher = (url, options) => {
  console.log('NOISE while fetching');
  return originalFetcher(url, options);
};
await serveStdio(server, protocol);
shutdown();
await env.cleanup();
