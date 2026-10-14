/**
 * Child process for the two-process ingest race: its own MCP server and client (in memory) over
 * a store and registry shared with its sibling through the directory in argv[2]. Prints the
 * ingest tool's JSON result. Run with `node --import tsx`.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sniffFormat } from '../../src/core/fetch/index.js';
import { LocalBackend } from '../../src/core/index/index.js';
import { Registry } from '../../src/core/registry.js';
import { createMcpServer, TOOL_NAMES } from '../../src/mcp/server.js';
import { FakeEmbedder, FakeReranker } from '../contracts/fake-local-models.js';
import { makeAmendmentHtml } from '../synth/index.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: mcp-ingest-child <dir>');
const page = makeAmendmentHtml().bytes;
const url = 'https://example.gov/permit.html';

const server = createMcpServer(
  {
    backend: new LocalBackend({
      root: join(dir, 'store'),
      embedder: new FakeEmbedder(),
      reranker: new FakeReranker(),
    }),
    registry: new Registry(join(dir, 'config')),
    fetcher: (requested) =>
      Promise.resolve({
        docId: createHash('sha256').update(page).digest('hex'),
        bytes: page,
        finalUrl: requested,
        contentType: 'text/html',
        format: sniffFormat(page, 'text/html', requested),
        fromCache: false,
      }),
    now: () => new Date(),
    maxDocs: 5,
    retrievalMode: 'hybrid_rerank',
  },
  { waitMs: 60_000 },
);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'race', version: '1' });
await Promise.all([
  server.server.connect(serverSide),
  client.connect(clientSide),
]);
const result = await client.callTool({
  name: TOOL_NAMES.ingest,
  arguments: { url },
});
process.stdout.write(
  `${JSON.stringify((result.content as { text: string }[])[0]?.text)}\n`,
);
server.shutdown();
await client.close();
