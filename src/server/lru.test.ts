import { describe, expect, it } from 'vitest';
import { LruMap } from './lru.js';

describe('LruMap', () => {
  it('drops the least recently used key past its size, and reading refreshes a key', () => {
    const lru = new LruMap<number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    expect(lru.get('a')).toBe(1); // a is now the newest
    lru.set('d', 4);
    expect(lru.size).toBe(3);
    expect(lru.get('b')).toBeUndefined();
    expect([lru.get('a'), lru.get('c'), lru.get('d')]).toEqual([1, 3, 4]);
  });
  it('overwriting does not grow it, and a prefix can be cleared', () => {
    const lru = new LruMap<number>(5);
    lru.set('doc1:a', 1);
    lru.set('doc1:a', 2);
    lru.set('doc1:b', 3);
    lru.set('doc2:a', 4);
    expect(lru.size).toBe(3);
    lru.deletePrefix('doc1:');
    expect(lru.size).toBe(1);
    expect(lru.get('doc2:a')).toBe(4);
  });
  it('refuses a size that is not a positive integer', () => {
    expect(() => new LruMap(0)).toThrow(RangeError);
    expect(() => new LruMap(1.5)).toThrow(RangeError);
  });
});
