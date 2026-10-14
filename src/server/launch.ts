import { envVar } from '../core/brand.js';
import type { CliRuntime } from '../cli/runtime.js';
import {
  openBrowser,
  startServer,
  type BrowserOpener,
  type RunningServer,
  type StartServerOptions,
} from './serve.js';

export interface LaunchRequest {
  port?: number | undefined;
  host?: string | undefined;
  publicMode: boolean;
  /** Set by `--no-open`. */
  noOpen?: boolean | undefined;
}

export type Launcher = (
  runtime: CliRuntime,
  request: LaunchRequest,
) => Promise<void>;

export interface LauncherDeps {
  start?: (
    runtime: CliRuntime,
    options: StartServerOptions,
  ) => Promise<RunningServer>;
  open?: BrowserOpener;
  write?: (text: string) => void;
  /** Environment consulted for BROWSER=none and the NO_OPEN variable. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Resolves when the process should stop serving. Default: SIGINT or SIGTERM. */
  untilStopped?: () => Promise<void>;
}

/** `BROWSER=none` is the common convention; the brand's NO_OPEN variable is the explicit one. */
function browserDisabled(env: NodeJS.ProcessEnv): boolean {
  const noOpen = env[envVar('NO_OPEN')]?.toLowerCase();
  return env.BROWSER === 'none' || noOpen === '1' || noOpen === 'true';
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

/**
 * Starts the server, prints its address, opens the browser (never for a public deployment,
 * which has no desktop to open it on, nor when --no-open, BROWSER=none or NO_OPEN asks for quiet), and keeps serving until told to stop.
 */
export function createLauncher(deps: LauncherDeps = {}): Launcher {
  const start = deps.start ?? startServer;
  const open = deps.open ?? openBrowser;
  const write =
    deps.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const env = deps.env ?? process.env;
  const untilStopped = deps.untilStopped ?? untilSignal;
  return async (runtime, request) => {
    const server = await start(runtime, {
      publicMode: request.publicMode,
      ...(request.port === undefined ? {} : { port: request.port }),
      ...(request.host === undefined ? {} : { host: request.host }),
    });
    write(`\nServing at ${server.url} (press Ctrl+C to stop)\n`);
    try {
      if (!request.publicMode && !request.noOpen && !browserDisabled(env)) {
        try {
          await open(server.url);
        } catch {
          /* the printed address is enough */
        }
      }
      await untilStopped();
    } finally {
      await server.close();
    }
  };
}
