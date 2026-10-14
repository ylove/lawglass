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
