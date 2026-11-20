/**
 * Retry attempts inside one provider call (issue #435). A provider that makes several HTTP
 * requests for one logical call (OpenAI falling back to a plainer response format, or dropping
 * `stream_options`) asks `gateRetry()` before each request after the first. The metering seam
 * installs what that does: it ends the previous attempt, gates the next one with a fresh call
 * id, and refuses it if the host's gate does. Outside a metered call it does nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<() => Promise<void>>();

/** Runs `fn` with `gate` as what `gateRetry()` calls. */
export function runWithRetryGate<T>(gate: () => Promise<void>, fn: () => T): T {
  return storage.run(gate, fn);
}

/** Wraps a stream so each step runs with `gate` installed (an async generator resumes in its caller's context). */
export function withRetryGate<T>(
  gate: () => Promise<void>,
  stream: AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const inner = stream[Symbol.asyncIterator]();
      return {
        next: () => storage.run(gate, () => inner.next()),
        return: (value?: unknown) =>
          storage.run(gate, () =>
            inner.return
              ? inner.return(value)
              : Promise.resolve({ done: true as const, value: undefined }),
          ),
        throw: (error?: unknown) =>
          storage.run(gate, () =>
            inner.throw
              ? inner.throw(error)
              : Promise.reject(
                  error instanceof Error ? error : new Error(String(error)),
                ),
          ),
      };
    },
  };
}

/** Call before every provider request after the first within one call; throws if the host refuses it. */
export async function gateRetry(): Promise<void> {
  await storage.getStore()?.();
}
