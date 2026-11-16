/**
 * Runs tasks that share a key one at a time, in arrival order, and lets different keys run
 * together. A task that throws still releases the next one.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      // Nothing queued behind this task: forget the key so the map does not grow.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
