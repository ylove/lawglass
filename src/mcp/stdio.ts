/**
 * Stdio hosting. On stdio, stdout IS the protocol channel: one stray `console.log` (ours, a
 * dependency's, a model-download progress line) would corrupt the stream. So we take the real
 * stdout for the transport alone and point everything else at stderr before anything runs.
 */
import type { Readable } from 'node:stream';
import { Writable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface StdioProcess {
  stdin: Readable;
  stdout: { write: NodeJS.WriteStream['write'] };
  stderr: { write: NodeJS.WriteStream['write'] };
}

export interface ClaimedStdout {
  /** The only writer to the real stdout: hand it to the transport. */
  protocol: Writable;
  restore(): void;
}

export function claimStdout(
  proc: StdioProcess = process,
  target: Pick<Console, 'log' | 'info' | 'debug'> = console,
): ClaimedStdout {
  const realWrite = proc.stdout.write.bind(proc.stdout);
  const protocol = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      realWrite(chunk, () => {
        callback();
      });
    },
  });
  const originalWrite = proc.stdout.write;
  const original = { log: target.log, info: target.info, debug: target.debug };
  // Anything else that writes to process.stdout lands on stderr instead.
  proc.stdout.write = ((...args: Parameters<NodeJS.WriteStream['write']>) =>
    (proc.stderr.write as (...a: unknown[]) => boolean)(
      ...args,
    )) as NodeJS.WriteStream['write'];
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  target.log = toStderr;
  target.info = toStderr;
  target.debug = toStderr;
  return {
    protocol,
    restore() {
      proc.stdout.write = originalWrite;
      Object.assign(target, original);
    },
  };
}

/** Serves `server` over stdio until the client closes stdin or the process is signalled. */
export async function serveStdio(
  server: McpServer,
  protocol: Writable,
  stdin: Readable = process.stdin,
  onSignal: (listener: () => void) => void = (listener) => {
    process.once('SIGINT', listener);
    process.once('SIGTERM', listener);
  },
): Promise<void> {
  const transport = new StdioServerTransport(stdin, protocol);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(transport);
  stdin.once('end', () => {
    void server.close();
  });
  onSignal(() => {
    void server.close();
  });
  await closed;
}
