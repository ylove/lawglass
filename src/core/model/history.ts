/**
 * Bill history gathered from official sources (Congress.gov, state legislature sites).
 *
 * Attribution rule: Name a person or committee only when the official record does. Never infer
 * a sponsor, committee or purpose; leave the field out instead. Dates are ISO strings.
 */
import { z } from 'zod';

export const BillHistory = z.object({
  /** The official summary, e.g. from the Congressional Research Service. */
  officialSummary: z
    .object({
      text: z.string(),
      /** Who wrote it, e.g. "Congressional Research Service". */
      source: z.string(),
      url: z.url(),
      date: z.string().optional(),
    })
    .optional(),
  versions: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      date: z.string().optional(),
      url: z.url().optional(),
    }),
  ),
  actions: z.array(
    z.object({
      date: z.string(),
      text: z.string(),
      chamber: z.string().optional(),
      committee: z.string().optional(),
      url: z.url().optional(),
    }),
  ),
  amendments: z.array(
    z.object({
      id: z.string(),
      number: z.string().optional(),
      status: z.enum([
        'adopted',
        'offered',
        'rejected',
        'withdrawn',
        'unknown',
      ]),
      sponsor: z
        .object({
          name: z.string(),
          bioguideId: z.string().optional(),
          memberId: z.string().optional(),
        })
        .optional(),
      committee: z.string().optional(),
      purpose: z.string().optional(),
      description: z.string().optional(),
      date: z.string().optional(),
      url: z.url().optional(),
    }),
  ),
  /** Every host the history was fetched from, for transparency in the UI. */
  sources: z.array(
    z.object({ host: z.string(), url: z.url(), fetchedAt: z.iso.datetime() }),
  ),
});
export type BillHistory = z.infer<typeof BillHistory>;
