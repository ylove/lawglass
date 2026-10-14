import { AppError } from '../model/index.js';
import { historySource } from './resolve.js';

/** Whole host equality, HTTPS, default port, and no credentials. Never suffix matching. */
export function assertHistoryUrl(source: string, input: string | URL): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError('SSRF_BLOCKED');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !historySource(source).hosts.includes(url.hostname)
  ) {
    throw new AppError('SSRF_BLOCKED', undefined, {
      userMessage: 'The history source address is not allowed.',
    });
  }
}
