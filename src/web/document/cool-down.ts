/**
 * After a failed run the server waits a minute before it starts another (`FAILED_RETRY_MS` in
 * server/summary.ts); asking sooner only returns the same error. Panels look again just after.
 */
export const SERVER_COOL_DOWN_MS = 61_000;
