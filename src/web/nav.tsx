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

/** Keeps `?mock=1` (and any other query) across in-app navigation. */
export function withSearch(path: string): string {
  return `${path}${window.location.search}`;
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
