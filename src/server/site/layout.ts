import { BRAND } from '../../core/brand.js';

// The only external destinations the public pages may link to. A test pins this set, so a new
// outbound link is a reviewed change rather than a copy edit.
export const HOSTED_CTA = `https://www.vouchnetworks.org/contact?intent=waitlist&product=${BRAND.name}#contact-form`;
export const LINKEDIN = 'https://linkedin.com/in/yitzjordan';
export const NODEJS = 'https://nodejs.org';

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] ?? char,
  );
}

/** An outbound link. New tab, no referrer or opener, and a spoken hint for screen readers. */
export function externalLink(
  href: string,
  label: string,
  className?: string,
): string {
  const cls = className ? ` class="${className}"` : '';
  return `<a${cls} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}<span class="vh"> (opens in a new tab)</span></a>`;
}

export interface PageContext {
  /** Deployment origin for link previews; never taken from the request. */
  origin: string | undefined;
  /** Which public files exist in the web root, so a missing one is omitted, not broken. */
  available: ReadonlySet<string>;
}

export interface PageMeta {
  title: string;
  description: string;
  /** Path used for og:url, e.g. "/" or "/quickstart". */
  path: string;
}

const MARK = `<svg class="mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="#0f3b6e" stroke="#7fb2e0" stroke-opacity="0.55"/><g stroke="#e6f0fa" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 9h15M6.5 14h9M6.5 19.5h6"/></g><circle cx="20" cy="19" r="6.2" fill="#0f3b6e" stroke="#8ec5f2" stroke-width="2.4"/><path d="M16.6 19h6.8" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/><path d="M24.6 23.6l3.4 3.4" stroke="#8ec5f2" stroke-width="3" stroke-linecap="round"/></svg>`;

export function head(ctx: PageContext, meta: PageMeta): string {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const origin = ctx.origin ?? '';
  const image = origin !== '' && ctx.available.has('/og-image.png');
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
${image ? `<meta property="og:image" content="${escapeHtml(`${origin}/og-image.png`)}">` : ''}
${origin ? `<meta property="og:url" content="${escapeHtml(`${origin}${meta.path}`)}">` : ''}
${ctx.available.has('/favicon.svg') ? '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' : ''}
${ctx.available.has('/apple-touch-icon.png') ? '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' : ''}
${ctx.available.has('/site.css') ? '<link rel="stylesheet" href="/site.css">' : ''}`;
}

export function header(): string {
  const name = escapeHtml(BRAND.displayName);
  return `<header class="site-header">
<div class="wrap bar">
<a class="brand" href="/">${MARK}<span>${name}</span></a>
<nav class="nav" aria-label="Main">
<a href="/#how">How it works</a>
<a href="/quickstart">Run it yourself</a>
${externalLink(BRAND.repositoryUrl, 'GitHub')}
</nav>
${externalLink(HOSTED_CTA, `Get hosted ${name}`, 'btn btn-primary btn-sm')}
</div>
</header>`;
}

export function footer(): string {
  const name = escapeHtml(BRAND.displayName);
  return `<footer class="site-footer">
<div class="wrap footer-grid">
<div class="footer-brand">
<a class="brand" href="/">${MARK}<span>${name}</span></a>
<p>Built by ${externalLink(LINKEDIN, 'Yitz Jordan')}</p>
</div>
<nav aria-label="Product">
<h2>Product</h2>
<ul>
<li><a href="/#how">How it works</a></li>
<li><a href="/quickstart">Run it yourself</a></li>
<li><a href="/#hosted">Hosted ${name}</a></li>
</ul>
</nav>
<nav aria-label="Connect">
<h2>Connect</h2>
<ul>
<li>${externalLink(HOSTED_CTA, 'Get in touch')}</li>
<li>${externalLink(LINKEDIN, 'LinkedIn')}</li>
<li>${externalLink(BRAND.repositoryUrl, 'GitHub')}</li>
</ul>
</nav>
<p class="fine">Not legal advice. Bill text comes from official sources; explanations are written by an AI model and checked against that text. Open source under the MIT license.</p>
</div>
</footer>`;
}

/** Wraps a page's <main> content in the shared document shell. */
export function renderPage(
  ctx: PageContext,
  meta: PageMeta,
  main: string,
): string {
  return `<!doctype html>
<html lang="en"><head>
${head(ctx, meta)}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header()}
<main id="main">
${main}
</main>
${footer()}
</body></html>`;
}
