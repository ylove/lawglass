/**
 * "What this means for someone like you": a short illustrated example. The model picks ids from
 * closed enums and writes captions; it can never emit SVG or HTML. Every frame cites the bill.
 */
import { z } from 'zod';
import { SectionId } from './doc.js';

/** Neutral stand-in figures; none depicts a real person. */
export const AvatarId = z.enum([
  'person-a',
  'person-b',
  'person-c',
  'person-d',
  'family',
  'business-owner',
  'worker',
  'student',
  'retiree',
]);
export type AvatarId = z.infer<typeof AvatarId>;

export const IconId = z.enum([
  'bank',
  'house',
  'document',
  'money',
  'tax',
  'school',
  'hospital',
  'car',
  'gun',
  'vote',
  'court',
  'police',
  'store',
  'factory',
  'farm',
  'water',
  'power',
  'phone',
  'internet',
  'calendar',
  'clock',
  'check',
  'no',
  'warning',
  'family',
  'health',
  'child',
  'job',
  'food',
  'scale',
]);
export type IconId = z.infer<typeof IconId>;

/** A number shown in a frame, with where it came from. */
export const ScenarioFigure = z
  .object({
    value: z.number(),
    /** Short free-form unit, e.g. "USD", "percent", "days". */
    unit: z.string().min(1).max(20),
    source: z.enum(['bill', 'assumption', 'computed']),
    /** How a `computed` value was derived, e.g. "50000 * 0.04". */
    expr: z.string().optional(),
  })
  .refine((f) => f.source !== 'computed' || (f.expr ?? '').length > 0, {
    message: 'a computed figure needs expr',
    path: ['expr'],
  });
export type ScenarioFigure = z.infer<typeof ScenarioFigure>;

export const ScenarioFrame = z.object({
  kind: z.enum(['setup', 'rule', 'effect']),
  avatar: AvatarId,
  icon: IconId,
  caption: z.string().min(1).max(200),
  /** Section ids from the bill supporting this frame. */
  citations: z.array(SectionId),
  figures: z.array(ScenarioFigure).optional(),
});
export type ScenarioFrame = z.infer<typeof ScenarioFrame>;

export const Scenario = z.object({
  subject: z.string(),
  profile: z.object({
    name: z.string(),
    label: z.string(),
    assumptions: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        value: z.number(),
        unit: z.string(),
      }),
    ),
    /** Always true: the example is made up and must be labelled so. */
    illustrative: z.literal(true),
  }),
  frames: z.array(ScenarioFrame).min(3).max(4),
});
export type Scenario = z.infer<typeof Scenario>;
