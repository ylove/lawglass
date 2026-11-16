/**
 * Synthetic section trees shaped like real bills, for sizing tests. The cost estimator reads
 * only counts and lengths, so what matters is how many sections there are, how deep the
 * breadcrumb is, how long the headings run and how much text each leaf carries.
 *
 * Shape: `divisions` divisions, each with `titles` titles, each with `sectionsPerTitle`
 * sections, so the tree holds divisions * (1 + titles * (1 + sectionsPerTitle)) sections.
 * Leaves carry page and line positions, as a PDF-sourced bill does.
 */
import type { Section } from '../../src/core/model/index.js';

export interface BillShape {
  divisions: number;
  titles: number;
  sectionsPerTitle: number;
  /** Characters of text in each leaf section. */
  sectionChars: number;
  /** Characters in every division, title and section heading: they make up the breadcrumb. */
  headingChars: number;
}

const WORDS =
  'the secretary shall establish a program to award grants for eligible entities under this section and report annually'.split(
    ' ',
  );

/** Plain words of exactly `chars` characters, starting at word `seed` so neighbours differ. */
function words(chars: number, seed: number): string {
  let out = '';
  for (let i = seed; out.length < chars; i++)
    out += `${WORDS[i % WORDS.length] ?? ''} `;
  return out.trim().slice(0, chars);
}

export function shapedBill(shape: BillShape): Section[] {
  let leaf = 0;
  return Array.from({ length: shape.divisions }, (_, d) => {
    const division = `division-${String.fromCharCode(97 + d)}`;
    return {
      id: division,
      num: String.fromCharCode(65 + d),
      heading: words(shape.headingChars, d),
      level: 1,
      spans: [],
      children: Array.from({ length: shape.titles }, (_, t) => {
        const title = `${division}/title-${String(t + 1)}`;
        return {
          id: title,
          num: `Title ${String(t + 1)}`,
          heading: words(shape.headingChars, t + 3),
          level: 2,
          spans: [],
          children: Array.from({ length: shape.sectionsPerTitle }, () => {
            leaf++;
            return {
              id: `${title}/sec-${String(leaf)}`,
              num: String(leaf),
              heading: words(shape.headingChars, leaf),
              level: 3,
              spans: [
                {
                  text: words(shape.sectionChars, leaf),
                  status: 'unchanged' as const,
                  page: 1 + Math.floor(leaf / 9),
                  line: 1 + (leaf % 40),
                },
              ],
              children: [],
            };
          }),
        };
      }),
    };
  });
}

/** S. 1582 (119th): 684 sections, 119,389 live characters. */
export const S1582_SHAPE: BillShape = {
  divisions: 2,
  titles: 11,
  sectionsPerTitle: 30,
  sectionChars: 181,
  headingChars: 72,
};
/** Ohio S.B. 113: 101 sections, 24,913 live characters. */
export const OHIO_SHAPE: BillShape = {
  divisions: 1,
  titles: 4,
  sectionsPerTitle: 24,
  sectionChars: 249,
  headingChars: 42,
};
