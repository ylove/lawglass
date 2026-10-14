import { describe, expect, it } from 'vitest';
import { chunkTypeFor } from './chunk-type.js';

describe('chunkTypeFor', () => {
  it('defers to the chunker heuristics when no term is defined', () => {
    expect(chunkTypeFor('A fine of $100 applies.', undefined, undefined)).toBe(
      'penalty',
    );
    expect(chunkTypeFor('Employers shall file.', 'Filing', undefined)).toBe(
      'operative',
    );
    expect(chunkTypeFor('Text.', 'Definitions', undefined)).toBe('definition');
  });

  it('overrides to definition when a term is defined, even with penalty words', () => {
    expect(
      chunkTypeFor(
        '"Violation" means an offense punishable by a fine.',
        'Terms',
        'Violation',
      ),
    ).toBe('definition');
  });
});
