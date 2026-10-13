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
