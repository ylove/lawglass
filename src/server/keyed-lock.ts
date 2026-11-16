/** How long a holder may keep a key before the next waiter is let in regardless. */
export const LOCK_LEASE_MS = 60_000;

interface Waiter {
  grant: () => void;
  holder: object;
}
interface KeyState {
  /** Identifies who holds the key now; a stale holder's release must not touch a later one. */
  holder: object;
  lease: ReturnType<typeof setTimeout>;
  waiting: Waiter[];
}

/**
 * Runs tasks that share a key one at a time, in arrival order, and lets different keys run
 * together. A task that throws still releases the next one.
 *
 * Two things keep a stuck request from blocking a key for good (for example a host's admission
 * that never answers): a waiter whose signal aborts leaves the queue without running, and a
 * holder is only leased the key. After the lease the next waiter goes ahead while the holder's
 * task carries on; ordering is best-effort from then on, and the late holder's release is
 * ignored.
 */
export class KeyedLock {
  private readonly keys = new Map<string, KeyState>();

  constructor(private readonly leaseMs = LOCK_LEASE_MS) {}

  async run<T>(
    key: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const holder = await this.acquire(key, signal);
    try {
      // The wait may have been long: a reader who left meanwhile does no work.
      signal?.throwIfAborted();
      return await task();
    } finally {
      this.release(key, holder);
    }
  }

  private acquire(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<object> {
    const holder = {};
    const state = this.keys.get(key);
    if (!state) {
      this.keys.set(key, this.newState(key, holder));
      return Promise.resolve(holder);
    }
    return new Promise<object>((resolve, reject) => {
      const waiter: Waiter = {
        holder,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(holder);
        },
      };
      const onAbort = (): void => {
        const at = state.waiting.indexOf(waiter);
        if (at >= 0) state.waiting.splice(at, 1);
        reject(signal?.reason as Error);
      };
      state.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private newState(key: string, holder: object): KeyState {
    const lease = setTimeout(() => {
      this.release(key, holder);
    }, this.leaseMs);
    // A pending lease must not keep the process alive.
    lease.unref();
    return { holder, lease, waiting: [] };
  }

  /** Hands the key to the next waiter, or forgets it. Does nothing for a holder that was leased out. */
  private release(key: string, holder: object): void {
    const state = this.keys.get(key);
    if (state?.holder !== holder) return;
    clearTimeout(state.lease);
    const next = state.waiting.shift();
    if (!next) {
      this.keys.delete(key);
      return;
    }
    const successor = this.newState(key, next.holder);
    successor.waiting = state.waiting;
    this.keys.set(key, successor);
    next.grant();
  }
}
