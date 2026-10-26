/**
 * Picture panels (#343): a small drawing above a summary bullet or a section brief, so a reader
 * who does not read well still gets the gist ("the bank gives coins to a person; it needs a
 * seal that says federal"). The bullet's own words stay underneath as the caption.
 *
 * The model never draws. It picks glyphs from a closed set and arranges them in a fixed grammar,
 * left side, a link, right side, an optional stamp, and the web maps each id to a neutral icon.
 * Labels are short and must come from the caption's own words (checked in core/picture).
 */
import { z } from 'zod';
import { SectionId } from './doc.js';

/**
 * Everything a panel can show. Generic and neutral: no faces, flags, party colours or weapons
 * (public safety is `shield`). Typed as a closed enum so a new glyph needs this contract.
 */
export const GlyphId = z.enum([
  // people and organizations
  'person',
  'people',
  'family',
  'child',
  'student',
  'worker',
  'retiree',
  'business',
  'store',
  'factory',
  'farm',
  'bank',
  'government',
  'court',
  'police',
  'school',
  'hospital',
  // money
  'money',
  'coins',
  'wallet',
  'credit-card',
  'vault',
  'tax',
  'percent',
  'chart-up',
  'chart-down',
  // paper, records and messages
  'document',
  'mail',
  'id-card',
  'seal',
  'newspaper',
  'megaphone',
  'database',
  // time
  'calendar',
  'clock',
  'hourglass',
  // safety and oversight
  'lock',
  'shield',
  'eye',
  'scale',
  'vote',
  'handshake',
  'warning',
  // things and places
  'house',
  'car',
  'truck',
  'bus',
  'plane',
  'ship',
  'package',
  'fuel',
  'power',
  'water',
  'tree',
  'food',
  'pill',
  'health',
  'job',
  'computer',
  'phone',
  'internet',
]);
export type GlyphId = z.infer<typeof GlyphId>;

/** Badges that sit on the left side of a panel: approved, allowed, not allowed, when, careful. */
export const StampId = z.enum([
  'seal',
  'check',
  'no',
  'calendar',
  'clock',
  'warning',
]);
export type StampId = z.infer<typeof StampId>;

/** A short label drawn under glyphs or on a stamp, e.g. "Federal", "Monthly", "1 to 1". */
export const PictureLabel = z.string().min(1).max(24);

export const PictureSide = z.object({
  glyphs: z.array(GlyphId).min(1).max(3),
  label: PictureLabel.optional(),
});
export type PictureSide = z.infer<typeof PictureSide>;

/**
 * How the two sides relate:
 * - `to`: something goes from left to right (the left gives, sends, pays or reports to the right);
 * - `both`: an exchange between the two sides;
 * - `equals`: the left is backed by, or must match, the right;
 * - `blocked`: the left may not give or do this to the right;
 * - `none`: only the left side, usually with a stamp.
 */
export const PictureLink = z.enum(['to', 'both', 'equals', 'blocked', 'none']);
export type PictureLink = z.infer<typeof PictureLink>;

export const PicturePanel = z.object({
  left: PictureSide,
  link: PictureLink,
  /** What moves along the link, drawn on the arrow (coins, a document). */
  carry: GlyphId.optional(),
  /** A word or two on the link, e.g. "monthly". */
  note: PictureLabel.optional(),
  right: PictureSide.optional(),
  stamp: z
    .object({ glyph: StampId, label: PictureLabel.optional() })
    .optional(),
});
export type PicturePanel = z.infer<typeof PicturePanel>;

/**
 * The picture for one item. `text` is the item's source text exactly as it appears in the answer
 * or brief (citation markers included); the client attaches a picture only when it matches, so
 * a picture can never sit above a sentence it was not drawn from.
 */
export const PictureEntry = z.object({
  /** The item's position: a list item of the summary, or a brief in the breakdown. */
  item: z.number().int().min(0).max(199),
  text: z.string().min(1).max(4000),
  /** For a breakdown brief, the part of the bill it describes. */
  sectionId: SectionId.optional(),
  panels: z.array(PicturePanel).min(1).max(3),
});
export type PictureEntry = z.infer<typeof PictureEntry>;

/**
 * GET /api/docs/:docId/summary/pictures and /breakdown/pictures. `none`: there was nothing to
 * draw (no list items, or no item could be drawn honestly). `disabled`: not on this server.
 */
export const PicturesResponse = z.object({
  status: z.enum(['cached', 'pending', 'none', 'disabled']),
  entries: z.array(PictureEntry).max(200).optional(),
});
export type PicturesResponse = z.infer<typeof PicturesResponse>;
