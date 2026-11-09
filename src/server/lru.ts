/**
 * A small least-recently-used map: reading or writing a key makes it the newest, and the oldest
 * keys go once `max` is passed. Used for records that are cheap to read back from disk, so
 * forgetting one only costs a read.
 */
export class LruMap<V> {
  private readonly items = new Map<string, V>();

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1)
      throw new RangeError('An LRU needs a positive integer size.');
  }

  get size(): number {
    return this.items.size;
  }

  get(key: string): V | undefined {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    for (const oldest of this.items.keys()) {
      if (this.items.size <= this.max) break;
      this.items.delete(oldest);
    }
  }

  /** Forgets every key that starts with `prefix` (a document's records). */
  deletePrefix(prefix: string): void {
    for (const key of this.items.keys())
      if (key.startsWith(prefix)) this.items.delete(key);
  }
}
