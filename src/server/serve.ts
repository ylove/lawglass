import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve as nodeServe } from '@hono/node-server';
import type { CliRuntime } from '../cli/runtime.js';
import { AppError } from '../core/model/index.js';
import { createApp, type AppOptions } from './app.js';

export type BrowserOpener = (url: string) => void | Promise<void>;

/** Opens a URL in the user's default browser. Failure is silent: the URL is printed anyway. */
export const openBrowser: BrowserOpener = (url) => {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
};

export interface StartServerOptions extends AppOptions {
  /** Defaults to the runtime's configured port. 0 picks a free port. */
  port?: number;
  /** Defaults to loopback. Anything else exposes the server to the network. */
  host?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Where `tsup` puts the built UI relative to the server bundle (dist/server.js, dist/web). */
export function defaultWebRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'web');
}

const LOOPBACK = '127.0.0.1';

export async function startServer(
  runtime: CliRuntime,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const host = options.host ?? LOOPBACK;
  const app = createApp(runtime, {
    webRoot: defaultWebRoot(),
    localOnly: !options.publicMode && ['127.0.0.1', 'localhost'].includes(host),
    ...options,
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = nodeServe(
      { fetch: app.fetch, port: options.port ?? runtime.port, hostname: host },
      () => {
        resolve(s as Server);
      },
    );
    s.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new AppError('INVALID_INPUT', error.message, {
              userMessage: `Port ${String(options.port ?? runtime.port)} is already in use. Try --port with another number.`,
            })
          : error,
      );
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `http://${host === LOOPBACK ? 'localhost' : host}:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
