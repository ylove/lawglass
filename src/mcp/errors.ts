/**
 * Tool errors. A hostile document must never reach an error message, so the text of every error
 * comes from this file (or from the fixed `ERROR_CODES` table), never from the document, the
 * registry, a filesystem error or a thrown value's own message.
 */
import { AppError, ERROR_CODES } from '../core/model/index.js';

export type ToolErrorCode =
  keyof typeof ERROR_CODES | 'NOT_INGESTED' | 'INTERNAL' | 'CANCELLED';

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ErrorPayload {
  error: { code: ToolErrorCode; message: string };
}

const NOT_INGESTED_MESSAGE =
  'That document is not ingested here. Call the ingest tool with its URL first (it may also have been evicted to stay under the document limit).';

export function notIngested(): ToolError {
  return new ToolError('NOT_INGESTED', NOT_INGESTED_MESSAGE);
}

/** Maps anything thrown to a fixed code and message. Never echoes a thrown value's text. */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof ToolError)
    return { error: { code: error.code, message: error.message } };
  if (error instanceof AppError) {
    if (error.code === 'DOC_NOT_FOUND')
      return { error: { code: 'NOT_INGESTED', message: NOT_INGESTED_MESSAGE } };
    return { error: { code: error.code, message: ERROR_CODES[error.code] } };
  }
  if (error instanceof Error && error.name === 'AbortError')
    return {
      error: { code: 'CANCELLED', message: 'The request was cancelled.' },
    };
  return {
    error: {
      code: 'INTERNAL',
      message: 'The request could not be completed.',
    },
  };
}
