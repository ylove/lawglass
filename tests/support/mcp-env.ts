/**
 * MCP test harness: the real server over an in-memory transport with the pipeline test doubles
 * (fake embedder, temp registry, injected fetcher). No network, no models, no stdio.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CliRuntime } from '../../src/cli/runtime.js';
import {
  createMcpServer,
  type McpServerOptions,
} from '../../src/mcp/server.js';
import type { PdfParser } from '../../src/core/pipeline/index.js';
import { makePipelineEnv, type PipelineEnv } from './pipeline-env.js';

export interface McpEnv {
  env: PipelineEnv;
  client: Client;
  /** Calls a tool and parses its JSON text; checks `structuredContent` agrees on success. */
  call(
    name: string,
    args: Record<string, unknown>,
    options?: Parameters<Client['callTool']>[2],
  ): Promise<{ isError: boolean; json: Record<string, unknown>; text: string }>;
  close(): Promise<void>;
}

export async function makeMcpEnv(
  options: {
    server?: McpServerOptions;
    parsePdf?: PdfParser;
    runtime?: (base: CliRuntime) => CliRuntime;
  } = {},
): Promise<McpEnv> {
  const env = await makePipelineEnv(
    options.parsePdf ? { parsePdf: options.parsePdf } : {},
  );
  const runtime = options.runtime ? options.runtime(env.runtime) : env.runtime;
  const { server, shutdown } = createMcpServer(runtime, options.server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    env,
    client,
    async call(name, args, callOptions) {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        callOptions,
      );
      const content = result.content as { type: string; text: string }[];
      const text = content[0]?.text ?? '';
      // Input-schema failures come back from the SDK as plain "MCP error ..." text.
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {
          isError: result.isError === true,
          json: { schemaError: text },
          text,
        };
      }
      if (!result.isError && result.structuredContent !== json) {
        // Same payload both ways, so clients that read either see the same thing.
        if (JSON.stringify(result.structuredContent) !== JSON.stringify(json))
          throw new Error('structuredContent differs from the text content');
      }
      return { isError: result.isError === true, json, text };
    },
    async close() {
      shutdown();
      await client.close();
      await env.cleanup();
    },
  };
}
