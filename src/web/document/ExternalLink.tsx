import type { ReactNode } from 'react';

/** Opens in a new tab, so say so for screen readers; the page behind it is not ours. */
export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Names the official site for a link label from its host, never from record text. */
export function officialSiteName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host === 'congress.gov') return 'Congress.gov';
    if (host === 'legislature.ohio.gov') return 'the Ohio Legislature';
    return host;
  } catch {
    return 'the official site';
  }
}
