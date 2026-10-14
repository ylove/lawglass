import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Hand labels for struck and inserted words in a real redline PDF, used to measure mark
 * recovery (#193). Labels store no document text: a line is found by its baseline and checked
 * by a hash of its tokens, so the label file can be committed while the PDF stays local.
 */
export const MarkLabel = z.object({
  token: z.number().int().nonnegative(),
  status: z.enum(['struck', 'inserted', 'ambiguous']),
  evidence: z.enum([
    'vector-underline',
    'raster-underline',
    'raster-dash',
    'none',
  ]),
  /** Character range [start, end) within the token, for OCR words that merge two statuses. */
  chars: z
    .tuple([z.number().int().nonnegative(), z.number().int().positive()])
    .refine(
      ([start, end]) => start < end,
      'chars must be a nonempty [start, end) range',
    )
    .optional(),
});
export type MarkLabel = z.infer<typeof MarkLabel>;

/**
 * A token may carry several marks only when each names a character range and the
 * ranges do not overlap (a merged OCR word). Returns a description of the first problem.
 */
export function markConflict(
  marks: MarkLabel[],
  tokenCount: number,
): string | undefined {
  const byToken = new Map<number, MarkLabel[]>();
  for (const mark of marks) {
    if (mark.token >= tokenCount) {
      return `token ${String(mark.token)} is outside the line's ${String(tokenCount)} tokens`;
    }
    byToken.set(mark.token, [...(byToken.get(mark.token) ?? []), mark]);
  }
  for (const [token, group] of byToken) {
    if (group.length === 1) continue;
    const ranges: [number, number][] = [];
    for (const mark of group) {
      if (!mark.chars) {
        return `token ${String(token)} has several marks, one without a chars range`;
      }
      ranges.push(mark.chars);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i += 1) {
      if ((ranges[i]?.[0] ?? 0) < (ranges[i - 1]?.[1] ?? 0)) {
        return `token ${String(token)} has overlapping chars ranges`;
      }
    }
  }
  return undefined;
}

export const MarkLabelFile = z
  .object({
    fixture: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    page: z.number().int().positive(),
    lines: z.array(
      z.object({
        y: z.number(),
        tokenCount: z.number().int().positive(),
        lineHash: z.string().regex(/^[a-f0-9]{16}$/),
        marks: z.array(MarkLabel).min(1),
      }),
    ),
  })
  .superRefine((file, context) => {
    file.lines.forEach((line, lineIndex) => {
      const problem = markConflict(line.marks, line.tokenCount);
      if (problem) {
        context.addIssue({
          code: 'custom',
          path: ['lines', lineIndex, 'marks'],
          message: problem,
        });
      }
    });
  });
export type MarkLabelFile = z.infer<typeof MarkLabelFile>;

export interface PageLine {
  y: number;
  tokens: string[];
}

interface PositionedText {
  str: string;
  x: number;
  y: number;
}

/**
 * Group text items into lines and split them into tokens, exactly as the labels were made:
 * baselines within 2.5pt form one line, items are ordered by x and joined with single spaces.
 * Lines come back top to bottom.
 */
export function groupLines(items: PositionedText[]): PageLine[] {
  const lines: { y: number; parts: PositionedText[] }[] = [];
  for (const item of items) {
    if (!item.str.trim()) continue;
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) < 2.5);
    if (!line) {
      line = { y: item.y, parts: [] };
      lines.push(line);
    }
    line.parts.push(item);
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => ({
      y: Math.round(line.y * 10) / 10,
      tokens: line.parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.str)
        .join(' ')
        .split(/\s+/)
        .filter(Boolean),
    }));
}

export function tokensHash(tokens: string[]): string {
  return createHash('sha256')
    .update(tokens.join(' '))
    .digest('hex')
    .slice(0, 16);
}
