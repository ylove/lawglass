import { BRAND } from '../../core/brand.js';
import {
  HOSTED_CTA,
  LINKEDIN,
  escapeHtml,
  externalLink,
  renderPage,
  type PageContext,
} from './layout.js';

const name = escapeHtml(BRAND.displayName);

/** A screenshot in a CSS-drawn window frame; omitted when the file is not deployed. */
function shot(ctx: PageContext, path: string, alt: string, cls = ''): string {
  if (!ctx.available.has(path)) return '';
  return `<figure class="shot ${cls}"><img src="${path}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async"></figure>`;
}

const ICON = {
  cite: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  scale: '<circle cx="12" cy="12" r="8"/><path d="M8 12h8"/>',
  code: '<path d="M9 8l-5 4 5 4M15 8l5 4-5 4"/>',
} as const;

function icon(path: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
}

interface Feature {
  title: string;
  body: string;
  bullets: string[];
  image: string;
  alt: string;
  /** Extra frame class; the history card is a narrow sidebar card, so it is not stretched. */
  frame?: string;
}

function features(): Feature[] {
  return [
    {
      title: 'In brief, in pictures',
      body: "Each main part of a bill becomes a small picture: who acts, what moves, what is required or not allowed. The bill's own words sit underneath, so nothing is left to the imagination.",
      bullets: [
        'Made for readers of every level',
        'Pictures only show what the sentence says',
        'Every point links to the text behind it',
      ],
      image: '/site/in-brief.jpg',
      alt: `${BRAND.displayName}'s In brief card: a short summary, then each main part shown as a simple picture with the bill's words underneath.`,
    },
    {
      title: 'Section by section',
      body: 'A plain brief of what each part of the bill does, with an example of how it could affect one person or business.',
      bullets: [
        'Briefs written at about a 7th-grade level',
        'Examples are clearly labelled as made up',
        'Cited to the section they describe',
      ],
      image: '/site/sections.jpg',
      alt: `${BRAND.displayName}'s section-by-section view: a plain brief of one part of a bill, with a labelled example and a citation.`,
    },
    {
      title: 'Find where it says that',
      body: `Heard a claim about a bill? Paste the sentence. ${BRAND.displayName} shows the passage that addresses it, copied word for word, with a receipt you can share. It never says who is right.`,
      bullets: [
        'Exact words from the bill',
        'Struck and added text labelled',
        'A copyable receipt with the source link',
      ],
      image: '/site/find.jpg',
      alt: 'The Find where it says that card: a pasted sentence, the matching passage from the bill copied word for word, and a copyable receipt.',
    },
    {
      title: 'How it got here',
      body: 'Versions, key actions, sponsors and the laws a bill refers to, from the official record, with links to the full history.',
      bullets: [
        'Amendments grouped by sponsor',
        'Every version linked',
        'People named only when the record names them',
      ],
      image: '/site/history.jpg',
      frame: 'shot-narrow',
      alt: "The How did it get here card: a bill's versions, key actions and sponsors, each linked to the official record.",
    },
  ];
}

function featureRows(ctx: PageContext): string {
  return features()
    .map((f, i) => {
      const image = shot(ctx, f.image, f.alt, f.frame);
      return `<article class="feature${i % 2 ? ' flip' : ''}${image ? '' : ' no-shot'}">
<div class="feature-text">
<h3>${escapeHtml(f.title)}</h3>
<p>${escapeHtml(f.body)}</p>
<ul class="ticks">${f.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
</div>
${image}
</article>`;
    })
    .join('\n');
}

const PROOF: [string, string][] = [
  [ICON.cite, 'Every sentence cites its section, page and line'],
  [ICON.edit, 'Reads struck and inserted text correctly'],
  [ICON.scale, 'Never tells you what to think'],
  [ICON.code, 'Open source, MIT licensed'],
];

const STEPS: [string, string][] = [
  [
    'Paste a link',
    'From Congress.gov, GovInfo, the Ohio Legislature, the New York Senate or Assembly or the New Jersey Legislature.',
  ],
  [
    `${BRAND.displayName} reads every section`,
    'It finds the structure of the bill, including the words it strikes and the words it adds.',
  ],
  [
    'Read it your way',
    'A short summary with pictures, a brief of each section, and answers to your own questions, each one cited.',
  ],
];

const TRUST: [string, string][] = [
  [
    'Citations are verified',
    'Every citation is checked against the bill text before you see it. An answer that cannot be traced to the text is not shown.',
  ],
  [
    'Not legal advice',
    `${BRAND.displayName} explains what a bill says. It does not tell you what to do, or whether a bill is good or bad.`,
  ],
  [
    'Your choice of model',
    'Run it on your own machine with Anthropic, OpenAI, Google or any OpenAI-compatible endpoint, or let us host it for you.',
  ],
];

const FAQ: [string, string][] = [
  [
    'Is this legal advice?',
    `No. ${BRAND.displayName} explains what a bill's text says and shows where it says it. For decisions about your situation, talk to a lawyer.`,
  ],
  [
    'Which bills does it read?',
    'U.S. federal bills from Congress.gov and GovInfo, Ohio bills from the Ohio Legislature, New York bills from the New York Senate and Assembly, and New Jersey bills from the New Jersey Legislature. Running it yourself, it can also read a PDF or XML file of a bill.',
  ],
  [
    'Where do the explanations come from?',
    `An AI model writes them from the bill's own text, and ${BRAND.displayName} checks every citation against that text before showing it. The hosted version uses Anthropic's Claude.`,
  ],
  [
    'Can I try it?',
    'The hosted version is in private preview. Ask for access, or run it yourself from GitHub today.',
  ],
  [
    'What does it cost?',
    'Running it yourself is free; you pay your AI provider for what you use. For hosted access, get in touch.',
  ],
];

export function landingPage(ctx: PageContext): string {
  const title = `${BRAND.displayName}: know what a bill really says`;
  const hero = shot(
    ctx,
    '/site/in-brief.jpg',
    `${BRAND.displayName}'s In brief card: a short summary, then each main part shown as a simple picture with the bill's words underneath and numbered citations.`,
    'hero-shot',
  );
  const main = `<section class="hero">
<div class="wrap hero-grid">
<div class="hero-text">
<p class="eyebrow">Open source · Federal, Ohio, New York and New Jersey bills</p>
<h1>Know what a bill really says.</h1>
<p class="lead">Paste a link to a bill. ${name} explains it in plain words and simple pictures, and points to the section, page and line behind every sentence.</p>
<div class="actions">
${externalLink(HOSTED_CTA, `Get hosted ${name}`, 'btn btn-primary')}
<a class="btn btn-secondary" href="/quickstart">Run it yourself</a>
</div>
<p class="small">Already have an invite link? Open it again to sign in.</p>
</div>
${hero}
</div>
</section>

<section class="proof" aria-label="What to expect">
<ul class="wrap proof-list">
${PROOF.map(([path, text]) => `<li>${icon(path)}<span>${escapeHtml(text)}</span></li>`).join('\n')}
</ul>
</section>

<section class="section" id="how" aria-labelledby="how-h">
<div class="wrap">
<h2 id="how-h">From a link to a clear picture</h2>
<ol class="how-steps">
${STEPS.map(([t, d]) => `<li><h3>${escapeHtml(t)}</h3><p>${escapeHtml(d)}</p></li>`).join('\n')}
</ol>
</div>
</section>

<section class="section features" aria-label="What you can do">
<div class="wrap">
${featureRows(ctx)}
</div>
</section>

<section class="section tinted" aria-labelledby="check-h">
<div class="wrap">
<h2 id="check-h">Built to be checked</h2>
<div class="cards">
${TRUST.map(([t, d]) => `<div class="card"><h3>${escapeHtml(t)}</h3><p>${escapeHtml(d)}</p></div>`).join('\n')}
</div>
</div>
</section>

<section class="hosted" id="hosted" aria-labelledby="hosted-h">
<div class="wrap hosted-grid">
<div>
<h2 id="hosted-h">Hosted ${name} for your team</h2>
<p>For newsrooms, advocacy groups, government-affairs teams, legal clinics and libraries that want plain-language bill explanations without running anything themselves.</p>
</div>
<div>
<ul class="ticks">
<li>A shared library of the bills you follow</li>
<li>No setup and no API keys to manage</li>
<li>Private access for your team</li>
</ul>
<div class="actions">
${externalLink(HOSTED_CTA, `Ask about hosted ${name}`, 'btn btn-light')}
${externalLink(LINKEDIN, 'Or connect on LinkedIn', 'link-light')}
</div>
</div>
</div>
</section>

<section class="section" aria-labelledby="self-h">
<div class="wrap self-grid">
<div>
<h2 id="self-h">Run it yourself</h2>
<p>${name} is open source. If you have Node.js and an AI provider key, you can run it on your own computer in a few minutes.</p>
<p class="links"><a href="/quickstart">Step-by-step quickstart</a> <span aria-hidden="true">·</span> ${externalLink(BRAND.repositoryUrl, 'Read the code on GitHub')}</p>
</div>
<pre tabindex="0"><code>git clone ${escapeHtml(BRAND.repositoryUrl)} &amp;&amp; cd ${escapeHtml(BRAND.name)}
npm ci &amp;&amp; npm run build
node dist/cli.js init</code></pre>
</div>
</section>

<section class="section tinted" aria-labelledby="faq-h">
<div class="wrap narrow">
<h2 id="faq-h">Questions</h2>
${FAQ.map(([q, a]) => `<details><summary>${escapeHtml(q)}</summary><p>${escapeHtml(a)}</p></details>`).join('\n')}
</div>
</section>`;
  return renderPage(
    ctx,
    { title, description: BRAND.description, path: '/' },
    main,
  );
}
