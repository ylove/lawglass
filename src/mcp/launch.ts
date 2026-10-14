/** `lawglass mcp`: claims stdout, builds the runtime, serves until the client goes away. */
import type { CliRuntime } from '../cli/runtime.js';
import { createMcpServer } from './server.js';
import { claimStdout, serveStdio } from './stdio.js';

export type McpLauncher = (open: () => Promise<CliRuntime>) => Promise<void>;

/** The process-level pieces, injectable so tests never touch the real stdout. */
export interface LaunchIo {
  claim: typeof claimStdout;
  serve: typeof serveStdio;
}

export function createMcpLauncher(
  io: LaunchIo = { claim: claimStdout, serve: serveStdio },
): McpLauncher {
  return async (open) => {
    // First, before config or model code can print anything.
    const { protocol } = io.claim();
    const runtime = await open();
    const { server, shutdown } = createMcpServer(runtime);
    try {
      await io.serve(server, protocol);
    } finally {
      shutdown();
    }
  };
}

export const launchMcp: McpLauncher = createMcpLauncher();
