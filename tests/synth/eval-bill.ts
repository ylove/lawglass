import type { Span } from '../../src/core/model/index.js';
import type { SyntheticSample } from './types.js';

interface EvalBillSection {
  num: string;
  heading: string;
  /** Paragraph HTML; `<s>` marks struck text and `<ins>` inserted text. */
  html: string;
}

const SECTIONS: EvalBillSection[] = [
  {
    num: '1',
    heading: 'Short title',
    html: 'This act may be cited as the Neighborhood Orchard Act.',
  },
  {
    num: '2',
    heading: 'Findings',
    html: 'The legislature finds that fruit trees planted on vacant lots improve air quality, shade sidewalks, and give nearby families access to fresh produce.',
  },
  {
    num: '3',
    heading: 'Definitions',
    html: 'As used in this act, "orchard steward" means a resident who volunteers to prune and harvest a public orchard. "Vacant lot" means a parcel with no building that the city has owned for at least two years.',
  },
  {
    num: '4',
    heading: 'Eligible sites',
    html: 'A city parcel qualifies for an orchard if it is a vacant lot, gets six hours of direct sunlight, and lies outside any flood hazard zone.',
  },
  {
    num: '5',
    heading: 'Planting grants',
    html: 'The parks department shall award each approved orchard a planting grant of up to eight thousand dollars to buy saplings, soil, and fencing.',
  },
  {
    num: '6',
    heading: 'Application deadline',
    html: 'An orchard application must be filed with the parks department no later than March 15 of each year.',
  },
  {
    num: '7',
    heading: 'Harvest permit fee',
    html: '<s>The harvest permit fee is twenty dollars for each orchard steward per season.</s> <ins>The harvest permit fee is twelve dollars for each orchard steward per season.</ins>',
  },
  {
    num: '8',
    heading: 'Irrigation',
    html: 'Orchards may draw water from a city hydrant only between sunrise and nine in the morning, and stewards must log every gallon drawn.',
  },
  {
    num: '9',
    heading: 'Pesticide use',
    html: '<s>Orchard stewards may apply any pesticide without advance notice to neighbors.</s> An orchard steward shall post notice seven days before applying a pesticide and may use only products approved by the state agriculture office.',
  },
  {
    num: '10',
    heading: 'Inspections',
    html: 'A parks inspector shall visit each orchard twice a year to check tree health, fencing, and the water log.',
  },
  {
    num: '11',
    heading: 'Penalties',
    html: 'An orchard steward who falsifies the water log shall pay a civil fine of five hundred dollars and lose the orchard permit for one year.',
  },
  {
    num: '12',
    heading: 'Annual report',
    html: 'By January 31 the parks department shall send the city council a report listing every orchard, the number of trees planted, and the pounds of fruit harvested.',
  },
  {
    num: '13',
    heading: 'Appropriation',
    html: 'The sum of two million dollars is appropriated from the general fund to the parks department to carry out this act.',
  },
  {
    num: '14',
    heading: 'Effective date',
    html: 'This act takes effect on January 1, 2028.',
  },
];

/** Split paragraph HTML into spans, mapping `<s>` to deleted and `<ins>` to inserted. */
function toSpans(html: string): Span[] {
  const spans: Span[] = [];
  const marked = /<(s|ins)>(.*?)<\/\1>/g;
  let from = 0;
  for (const match of html.matchAll(marked)) {
    if (match.index > from)
      spans.push({ text: html.slice(from, match.index), status: 'unchanged' });
    spans.push({
      text: match[2] ?? '',
      status: match[1] === 's' ? 'deleted' : 'inserted',
    });
    from = match.index + match[0].length;
  }
  if (from < html.length)
    spans.push({ text: html.slice(from), status: 'unchanged' });
  return spans;
}

/**
 * A fourteen-section synthetic bill with distinct topics, one definitions section, and two
 * struck passages of four or more words. Small enough to ingest in milliseconds, but big
 * enough that retrieval has to rank sections rather than return the whole document. Invented
 * text only: the golden set `src/eval/golden/synthetic-orchard.json` is written against it.
 */
export function makeEvalBillHtml(): SyntheticSample {
  const body = SECTIONS.map(
    (s) =>
      `    <section id="sec-${s.num}"><h2>Section ${s.num}. ${s.heading}</h2>\n      <p>${s.html}</p>\n    </section>`,
  ).join('\n');
  return {
    bytes: new TextEncoder().encode(
      `<!doctype html>\n<html lang="en"><head><title>Synthetic Neighborhood Orchard Bill</title></head>\n<body>\n  <main>\n${body}\n  </main>\n</body></html>\n`,
    ),
    groundTruth: {
      sections: SECTIONS.map((s) => ({
        id: `sec-${s.num}`,
        num: s.num,
        heading: s.heading,
        level: 1,
        spans: toSpans(s.html),
        children: [],
      })),
      deletedStrings: [
        'The harvest permit fee is twenty dollars for each orchard steward per season.',
        'Orchard stewards may apply any pesticide without advance notice to neighbors.',
      ],
      insertedStrings: [
        'The harvest permit fee is twelve dollars for each orchard steward per season.',
      ],
    },
  };
}
