import { describe, expect, it, vi } from 'vitest';
import type { Section } from '../model/index.js';
import { withInlineChanges } from '../pipeline/inline-changes.js';
import { billFacts } from './facts.js';

// A spy that still runs the real function: the sizing must not render per chunk.
vi.mock('../pipeline/inline-changes.js', async (original) => {
  const real = await original<typeof import('../pipeline/inline-changes.js')>();
  return { ...real, withInlineChanges: vi.fn(real.withInlineChanges) };
});

describe('sizing an amended bill that fits whole', () => {
  it('renders the changes inline once, over every chunk, however many a section has', () => {
    const section: Section = {
      id: 'sec-1',
      heading: 'Grants',
      level: 1,
      spans: Array.from({ length: 600 }, (_, i) => ({
        text: `Clause ${String(i)} of the grant program applies to each town. `,
        status: i % 3 === 0 ? ('deleted' as const) : ('unchanged' as const),
      })),
      children: [],
    };
    const facts = billFacts([section]);
    expect(facts.mode).toBe('whole');
    const calls = vi.mocked(withInlineChanges).mock.calls;
    expect(calls).toHaveLength(1);
    // Called with all the chunks at once and in whole mode, not once per chunk.
    expect(calls[0]?.[0].length).toBeGreaterThan(1);
    expect(calls[0]?.[3]).toBe(true);
  });
});
