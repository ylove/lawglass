import { ApiError } from './sse.js';

/** A message that is safe and plain enough to show a reader. */
export function errorMessage(e: unknown): string {
  return e instanceof ApiError
    ? e.message
    : 'Something went wrong. Please try again.';
}
