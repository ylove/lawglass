import type { SyntheticSample, SampleGroundTruth } from './types.js';

export interface HtmlGroundTruth extends SampleGroundTruth {
  noiseStrings: string[];
}

export function makeAmendmentHtml(): SyntheticSample<HtmlGroundTruth> {
  return {
    bytes: new TextEncoder().encode(`<!doctype html>
<html lang="en"><head><title>Synthetic Garden Permit Bill</title></head>
<body>
  <header>Legislative portal banner</header><nav>Portal navigation</nav>
  <main>
    <section id="sec-1"><h2>Section 1. Permit fees</h2>
      <p>The old fees are <s>five dollars</s>, <strike>ten dollars</strike>,
      <del>fifteen dollars</del>, and <span style="text-decoration: line-through">twenty dollars</span>.</p>
      <p>The new fees are <u>six dollars</u>, <ins>eleven dollars</ins>,
      and <span style="text-decoration: underline">sixteen dollars</span>.</p>
    </section>
    <section id="sec-2"><h2>Section 2. Effective date</h2>
      <p>This act takes effect on July 1, 2027.</p>
    </section>
  </main>
  <footer>Portal copyright notice</footer>
  <script>window.portalNoise = "Script-only noise";</script>
</body></html>`),
    groundTruth: {
      deletedStrings: [
        'five dollars',
        'ten dollars',
        'fifteen dollars',
        'twenty dollars',
      ],
      insertedStrings: ['six dollars', 'eleven dollars', 'sixteen dollars'],
      noiseStrings: [
        'Legislative portal banner',
        'Portal navigation',
        'Portal copyright notice',
        'Script-only noise',
      ],
      sections: [
        {
          id: 'sec-1',
          num: '1',
          heading: 'Permit fees',
          level: 1,
          children: [],
          spans: [
            { text: 'The old fees are ', status: 'unchanged' },
            { text: 'five dollars', status: 'deleted' },
            { text: ', ', status: 'unchanged' },
            { text: 'ten dollars', status: 'deleted' },
            { text: ', ', status: 'unchanged' },
            { text: 'fifteen dollars', status: 'deleted' },
            { text: ', and ', status: 'unchanged' },
            { text: 'twenty dollars', status: 'deleted' },
            { text: '. The new fees are ', status: 'unchanged' },
            { text: 'six dollars', status: 'inserted' },
            { text: ', ', status: 'unchanged' },
            { text: 'eleven dollars', status: 'inserted' },
            { text: ', and ', status: 'unchanged' },
            { text: 'sixteen dollars', status: 'inserted' },
            { text: '.', status: 'unchanged' },
          ],
        },
        {
          id: 'sec-2',
          num: '2',
          heading: 'Effective date',
          level: 1,
          children: [],
          spans: [
            {
              text: 'This act takes effect on July 1, 2027.',
              status: 'unchanged',
            },
          ],
        },
      ],
    },
  };
}

/**
 * Amendment markup applied the indirect ways real pages do it: stylesheet classes,
 * `text-decoration-line`, and marks nested inside each other (a struck insertion is deleted).
 * Links are underlined by an unrelated tag rule and must stay unchanged.
 */
export function makeStyledAmendmentHtml(): SyntheticSample<HtmlGroundTruth> {
  return {
    bytes: new TextEncoder().encode(`<!doctype html>
<html lang="en"><head><title>Synthetic Styled Bill</title>
<style>
/* Amendment classes */
.strike { text-decoration: line-through }
.under, span.add { text-decoration-line: underline; }
a { text-decoration: underline }
</style></head>
<body>
  <nav>Styled portal navigation</nav>
  <main>
    <section id="sec-1"><h2>Section 1. Permit fees</h2>
      <p>The old fee is <span class="strike">five dollars</span> and <span class="legacy strike">ten dollars</span>.</p>
      <p>The new fee is <span class="under">six dollars</span> or <span style="text-decoration-line: underline">seven dollars</span>.</p>
    </section>
    <section id="sec-2"><h2>Section 2. Nested marks</h2>
      <p>Pay <s>old <u>mid</u> fee</s> and <u>new <s>dropped</s> fee</u> see <a href="#fees">the portal</a>.</p>
    </section>
  </main>
</body></html>`),
    groundTruth: {
      deletedStrings: ['five dollars', 'ten dollars', 'old mid fee', 'dropped'],
      insertedStrings: ['six dollars', 'seven dollars', 'new ', ' fee'],
      noiseStrings: ['Styled portal navigation'],
      sections: [
        {
          id: 'sec-1',
          num: '1',
          heading: 'Permit fees',
          level: 1,
          children: [],
          spans: [
            { text: 'The old fee is ', status: 'unchanged' },
            { text: 'five dollars', status: 'deleted' },
            { text: ' and ', status: 'unchanged' },
            { text: 'ten dollars', status: 'deleted' },
            { text: '. The new fee is ', status: 'unchanged' },
            { text: 'six dollars', status: 'inserted' },
            { text: ' or ', status: 'unchanged' },
            { text: 'seven dollars', status: 'inserted' },
            { text: '.', status: 'unchanged' },
          ],
        },
        {
          id: 'sec-2',
          num: '2',
          heading: 'Nested marks',
          level: 1,
          children: [],
          spans: [
            { text: 'Pay ', status: 'unchanged' },
            { text: 'old mid fee', status: 'deleted' },
            { text: ' and ', status: 'unchanged' },
            { text: 'new ', status: 'inserted' },
            { text: 'dropped', status: 'deleted' },
            { text: ' fee', status: 'inserted' },
            { text: ' see the portal.', status: 'unchanged' },
          ],
        },
      ],
    },
  };
}
