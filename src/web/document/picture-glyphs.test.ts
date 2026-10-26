import { describe, expect, test } from 'vitest';
import { GlyphId, StampId } from '../../core/model/index.js';
import { GLYPH_ICONS, STAMP_ICONS } from './picture-glyphs.js';

describe('picture glyphs', () => {
  test('every glyph id has an icon', () => {
    for (const id of GlyphId.options) expect(GLYPH_ICONS[id]).toBeTruthy();
    expect(Object.keys(GLYPH_ICONS)).toHaveLength(GlyphId.options.length);
  });

  test('every stamp id has an icon', () => {
    for (const id of StampId.options) expect(STAMP_ICONS[id]).toBeTruthy();
    expect(Object.keys(STAMP_ICONS)).toHaveLength(StampId.options.length);
  });

  test('the people and institution glyphs a reader compares are distinct', () => {
    const distinct = [
      'person',
      'people',
      'family',
      'bank',
      'government',
    ] as const;
    expect(new Set(distinct.map((id) => GLYPH_ICONS[id])).size).toBe(
      distinct.length,
    );
  });
});
