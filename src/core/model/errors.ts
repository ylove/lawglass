/**
 * Error taxonomy. Every expected failure is an `AppError` with a stable `code` (for the API,
 * tests and eval) and a plain-language `userMessage` (for the CLI and UI). Internal detail goes
 * in `message`/`cause` and is never shown to end users verbatim. Never put API keys in either.
 */
export const ERROR_CODES = {
  INVALID_INPUT: 'That input is not valid.',
  SSRF_BLOCKED:
    'That address points to a private or local network, so it cannot be fetched.',
  FETCH_FAILED: 'The document could not be downloaded.',
  FETCH_TIMEOUT: 'The document took too long to download.',
  TOO_LARGE: 'The document is too large to process.',
  TOO_MANY_REDIRECTS: 'The link redirected too many times.',
  UNSUPPORTED_FORMAT:
    'This file type is not supported. Try an XML, HTML, PDF, or text link.',
  WRAPPER_PAGE:
    'This page links to the bill instead of containing it. Choose one of the linked files.',
  SCANNED_PDF: "This PDF appears to be scanned; OCR isn't supported yet.",
  PARSE_FAILED: 'The document could not be read.',
  MISSING_KEY:
    'An API key is missing. Run `init` or set the environment variable.',
  BACKEND_UNAVAILABLE: 'The search index is unavailable right now.',
  PROVIDER_ERROR: 'The language model request failed.',
  PROVIDER_BAD_OUTPUT: 'The language model returned an unexpected response.',
  DOC_NOT_FOUND: 'That document has not been loaded.',
  RATE_LIMITED: 'Too many requests. Please wait and try again.',
  PUBLIC_MODE_FORBIDDEN: 'That action is turned off on this public server.',
  DOC_CAP_REACHED: 'The document limit has been reached.',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  /** Optional structured detail safe to show (e.g. candidate links for WRAPPER_PAGE). */
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message?: string,
    opts?: {
      cause?: unknown;
      userMessage?: string;
      details?: Record<string, unknown>;
    },
  ) {
    super(message ?? ERROR_CODES[code], { cause: opts?.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = opts?.userMessage ?? ERROR_CODES[code];
    this.details = opts?.details;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
