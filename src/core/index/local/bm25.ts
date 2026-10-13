import { z } from 'zod';

const STOPWORDS = new Set(
  'a an and are as at be been by for from has have in is it its of on or that the this to was were with'.split(
    ' ',
  ),
);

/** Preserve statute numbers and section signs; currency separators aren't meaningful terms. */
export function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/\$?\d[\d,]*(?:\.\d+)?/g, (n) => n.replace(/[$,]/g, ''));
  return (normalized.match(/[\p{L}\p{N}]+(?:\.\d+)*|§/gu) ?? []).filter(
    (term) => !STOPWORDS.has(term),
  );
}

export const Bm25Index = z.object({
  lengths: z.array(z.number().int().nonnegative()),
  averageLength: z.number().nonnegative(),
  documentFrequency: z.record(z.string(), z.number().int().positive()),
  termFrequency: z.array(z.record(z.string(), z.number().int().positive())),
});
export type Bm25Index = z.infer<typeof Bm25Index>;

export function buildBm25(texts: readonly string[]): Bm25Index {
  const documentFrequency: Record<string, number> = Object.create(
    null,
  ) as Record<string, number>;
  const lengths: number[] = [];
  const termFrequency = texts.map((text) => {
    const terms = tokenize(text);
    lengths.push(terms.length);
    const frequency: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    for (const term of terms) frequency[term] = (frequency[term] ?? 0) + 1;
    for (const term of Object.keys(frequency)) {
      documentFrequency[term] = (documentFrequency[term] ?? 0) + 1;
    }
    return frequency;
  });
  return {
    lengths,
    averageLength: lengths.length
      ? lengths.reduce((a, b) => a + b, 0) / lengths.length
      : 0,
    documentFrequency,
    termFrequency,
  };
}

/** Per-namespace IDF, before filtering: a chip must not change the corpus statistics. */
export function scoreBm25(index: Bm25Index, query: string): number[] {
  const k1 = 1.2;
  const b = 0.75;
  const terms = [...new Set(tokenize(query))];
  return index.termFrequency.map((frequency, row) => {
    let score = 0;
    for (const term of terms) {
      const tf = Object.hasOwn(frequency, term) ? (frequency[term] ?? 0) : 0;
      const df = Object.hasOwn(index.documentFrequency, term)
        ? (index.documentFrequency[term] ?? 0)
        : 0;
      if (!tf || !df) continue;
      const idf = Math.log(1 + (index.lengths.length - df + 0.5) / (df + 0.5));
      const lengthRatio = (index.lengths[row] ?? 0) / index.averageLength;
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + b * lengthRatio));
    }
    return score;
  });
}
