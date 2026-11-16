/** How long a holder may keep a key before the next waiter is let in regardless. */
export const LOCK_LEASE_MS = 60_000;

/** Identifies one turn at a key; a stale holder's release must not touch a later turn. */
interface Holder {
  /** Aborts when the lease runs out, before the next waiter is let in. */
  lease: AbortController;
}
interface Waiter {
  grant: () => void;
  holder: Holder;
}
interface KeyState {
  holder: Holder;
  lease: ReturnType<typeof setTimeout>;
  waiting: Waiter[];
}

/**
 * Runs tasks that share a key one at a time, in arrival order, and lets different keys run
 * together. A task that throws still releases the next one.
 *
 * Two things keep a stuck request from blocking a key for good (for example a host's admission
 * that never answers): a waiter whose signal aborts leaves the queue without running, and a
 * holder is only leased the key. When the lease runs out the task's signal aborts, and only
 * then does the next waiter go ahead. A task must treat that abort as "your turn is over" and
 * not publish a result, so work that outlives its turn can never be seen after a later
 * holder's. The late holder's release is ignored.
 */
export class KeyedLock {
  private readonly keys = new Map<string, KeyState>();

  constructor(private readonly leaseMs = LOCK_LEASE_MS) {}

  async run<T>(
    key: string,
    /** Gets a signal that aborts when the lease runs out (the request's signal is separate). */
    task: (lease: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const holder = await this.acquire(key, signal);
    try {
      // The wait may have been long: a reader who left meanwhile does no work.
      signal?.throwIfAborted();
      return await task(holder.lease.signal);
    } finally {
      this.release(key, holder);
    }
  }

  private acquire(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<Holder> {
    const holder: Holder = { lease: new AbortController() };
    const state = this.keys.get(key);
    if (!state) {
      this.keys.set(key, this.newState(key, holder));
      return Promise.resolve(holder);
    }
    return new Promise<Holder>((resolve, reject) => {
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

  private newState(key: string, holder: Holder): KeyState {
    const lease = setTimeout(() => {
      holder.lease.abort(new Error('The lock lease ran out.'));
      this.release(key, holder);
    }, this.leaseMs);
    // A pending lease must not keep the process alive.
    lease.unref();
    return { holder, lease, waiting: [] };
  }

  /** Hands the key to the next waiter, or forgets it. Does nothing for a holder that was leased out. */
  private release(key: string, holder: Holder): void {
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
