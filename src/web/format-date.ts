const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

/**
 * "2025-01-23T05:00:00Z" or "2025-01-23" becomes "Jan 23, 2025". UTC keeps the day the record
 * states; a local zone could shift a midnight timestamp onto the neighbouring date. Anything
 * unparseable is returned unchanged rather than hidden.
 */
export function formatRecordDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : FORMAT.format(time);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "today", "yesterday", "3 days ago", then a short date after a week. For lists of the
 * reader's own recent activity, where "when" matters more than the exact day.
 */
export function formatRelativeDate(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const days = Math.floor((now - time) / DAY_MS);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${String(days)} days ago`;
  return formatRecordDate(iso);
}
