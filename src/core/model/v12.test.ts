// v1.2 contract additions (#343): picture panels. Additive only; nothing existing changes.
import { describe, expect, it } from 'vitest';
import {
  GlyphId,
  PictureEntry,
  PicturePanel,
  PicturesResponse,
  StampId,
} from './index.js';

const panel = {
  left: { glyphs: ['bank'], label: 'Federal' },
  link: 'to',
  carry: 'coins',
  right: { glyphs: ['person'] },
  stamp: { glyph: 'seal', label: 'Federal' },
};

describe('v1.2 picture contracts', () => {
  it('accepts the shapes the picture feature sends', () => {
    expect(PicturePanel.parse(panel)).toEqual(panel);
    expect(
      PictureEntry.parse({
        item: 0,
        text: 'Who can issue: bank subsidiaries [S:sec-4].',
        panels: [panel, { left: { glyphs: ['calendar'] }, link: 'none' }],
      }).panels,
    ).toHaveLength(2);
    expect(
      PictureEntry.parse({
        item: 3,
        text: 'This part sets reserve rules. [S:sec-4]',
        sectionId: 'sec-4',
        panels: [panel],
      }).sectionId,
    ).toBe('sec-4');
    expect(
      PicturesResponse.parse({ status: 'pending' }).entries,
    ).toBeUndefined();
    expect(PicturesResponse.parse({ status: 'none', entries: [] }).status).toBe(
      'none',
    );
  });

  it('keeps the drawing grammar closed', () => {
    for (const bad of [
      { ...panel, link: 'arrow' },
      { ...panel, carry: 'flag' },
      { ...panel, left: { glyphs: [] } },
      { ...panel, left: { glyphs: ['bank', 'bank', 'bank', 'bank'] } },
      { ...panel, left: { glyphs: ['bank'], label: 'x'.repeat(25) } },
      { ...panel, stamp: { glyph: 'bank' } },
      { ...panel, note: '' },
    ])
      expect(PicturePanel.safeParse(bad).success).toBe(false);
    expect(
      PictureEntry.safeParse({ item: 0, text: 't', panels: [] }).success,
    ).toBe(false);
    expect(
      PictureEntry.safeParse({
        item: 0,
        text: 't',
        panels: [panel, panel, panel, panel],
      }).success,
    ).toBe(false);
    expect(
      PictureEntry.safeParse({
        item: 0,
        text: 't',
        sectionId: 'has space',
        panels: [panel],
      }).success,
    ).toBe(false);
  });

  it('has neutral glyphs only: no flags, faces, parties or weapons', () => {
    for (const id of ['flag', 'gun', 'face', 'democrat', 'republican'])
      expect(GlyphId.options).not.toContain(id);
    expect(StampId.options).toEqual([
      'seal',
      'check',
      'no',
      'calendar',
      'clock',
      'warning',
    ]);
  });
});
