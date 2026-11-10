// Client-side routes without a router library: `/` is the homepage and `/doc/<docId>` a
// document. The server falls back to index.html for both, so a reload lands in the same place.
import {
  createContext,
  useContext,
  type MouseEvent,
  type ReactNode,
} from 'react';

export const HOME_PATH = '/';

export function docPath(docId: string): string {
  return `/doc/${encodeURIComponent(docId)}`;
}

/** The document id in a `/doc/<id>` path, or null for the homepage and anything unknown. */
export function parseDocPath(pathname: string): string | null {
  const match = /^\/doc\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Longest address a `/?url=` link may carry. Real bill addresses are far shorter. */
export const MAX_LINK_URL_LENGTH = 2000;

/** `/` with the bill address in `?url=`, for a link that opens the homepage form pre-filled. */
export function openUrlPath(address: string): string {
  return `${HOME_PATH}?url=${encodeURIComponent(address)}`;
}

/**
 * The address in a `?url=` query, or null. Only plain http(s) addresses of sane length are
 * accepted; anything else is ignored rather than shown, so a crafted link cannot smuggle text
 * or another scheme into the form.
 */
export function parseOpenUrl(search: string): string | null {
  const value = new URLSearchParams(search).get('url')?.trim();
  if (!value || value.length > MAX_LINK_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Keeps `?mock=1` (and any other query) across in-app navigation, merged with any query on the
 * destination itself. `url` is never carried: it belongs to the one page that was opened with it.
 */
export function withSearch(path: string): string {
  const [pathname = '', own = ''] = path.split('?', 2);
  const params = new URLSearchParams(window.location.search);
  params.delete('url');
  for (const [key, value] of new URLSearchParams(own)) params.set(key, value);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export const NavContext = createContext<(path: string) => void>(
  () => undefined,
);

/** A real anchor (works with the keyboard, middle click and "open in new tab"). */
export function Link({
  to,
  className,
  'aria-label': ariaLabel,
  children,
}: {
  to: string;
  className?: string;
  'aria-label'?: string;
  children: ReactNode;
}) {
  const navigate = useContext(NavContext);
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // Let the browser handle anything that is not a plain left click.
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    e.preventDefault();
    navigate(to);
  }
  return (
    <a
      href={withSearch(to)}
      className={className}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
