import { BRAND, envVar } from '../../core/brand.js';
import {
  HOSTED_CTA,
  NODEJS,
  escapeHtml,
  externalLink,
  renderPage,
  type PageContext,
} from './layout.js';

const BILL_URL =
  'https://www.congress.gov/bill/119th-congress/senate-bill/1582';

function code(lines: string[]): string {
  return `<pre tabindex="0"><code>${lines.map(escapeHtml).join('\n')}</code></pre>`;
}

interface Step {
  title: string;
  body: string;
  code?: string[];
}

function steps(): Step[] {
  const cli = 'node dist/cli.js';
  return [
    {
      title: 'Install Node.js 22.13 or newer',
      body: `Check with <code>node --version</code>. If you need it, download it from ${externalLink(NODEJS, 'nodejs.org')}.`,
    },
    {
      title: 'Get an AI provider key',
      // claude-cli is opt-in and flagged "local development only" in the README, so say so.
      body: `An API key from Anthropic, OpenAI or Google works. If you use Claude Code, you can set <code>${envVar('LLM_PROVIDER')}=claude-cli</code> to use it instead, with no key (meant for trying it out on your own computer).`,
    },
    {
      title: `Download ${BRAND.displayName}`,
      body: 'Copy the code to your computer and step into the folder.',
      code: [`git clone ${BRAND.repositoryUrl}`, `cd ${BRAND.name}`],
    },
    {
      title: 'Install and build',
      body: 'This installs what it needs and builds the app.',
      code: ['npm ci', 'npm run build'],
    },
    {
      title: 'Set up your provider',
      body: "It asks for each provider's key, hidden as you type. Press Enter to skip the ones you do not use. Keys are saved in a private file on your computer.",
      code: [`${cli} init`],
    },
    {
      title: 'Open a bill',
      body: `${BRAND.displayName} reads the bill, then opens it in your browser. The first time, it also downloads about 59 MB of search models, once.`,
      code: [`${cli} ${BILL_URL}`],
    },
    {
      title: 'Ask it anything',
      body: `Use the summary, the section-by-section view, the question buttons or your own questions. Every answer is cited. AI agents can use ${escapeHtml(BRAND.displayName)} too: <code>${cli} mcp</code> starts a Model Context Protocol server.`,
    },
  ];
}

export function quickstartPage(ctx: PageContext): string {
  const main = `<section class="doc">
<div class="wrap narrow">
<nav class="crumb" aria-label="Breadcrumb"><a href="/">Home</a></nav>
<h1>Run ${escapeHtml(BRAND.displayName)} on your computer</h1>
<p class="lead">About ten minutes. You need a terminal, Node.js and a key for an AI provider.</p>
<ol class="qs-steps">
${steps()
  .map(
    (s) => `<li>
<h2>${escapeHtml(s.title)}</h2>
<p>${s.body}</p>
${s.code ? code(s.code) : ''}
</li>`,
  )
  .join('\n')}
</ol>
<div class="callout">
<p>Stuck, or want more options (other providers, local files, the command-line tools)? The README on ${externalLink(BRAND.repositoryUrl, 'GitHub')} has everything.</p>
<p>Prefer us to host it? ${externalLink(HOSTED_CTA, `Get hosted ${escapeHtml(BRAND.displayName)}`, 'btn btn-primary')}</p>
</div>
</div>
</section>`;
  return renderPage(
    ctx,
    {
      title: `Run ${BRAND.displayName} yourself`,
      description: `Install ${BRAND.displayName} on your own computer and open a bill in about ten minutes.`,
      path: '/quickstart',
    },
    main,
  );
}
