// Reads a Server-Sent Events stream from a fetch() response. EventSource cannot POST, so the
// browser client parses the byte stream itself. Only `data:` lines matter to our contract: each
// event is one JSON object carrying its own `type`.
import type { ZodType } from 'zod';

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** Splits decoded text into SSE event payloads (the joined `data:` lines of each blank-line block). */
export function* parseSseBlocks(
  buffer: string,
  flush: boolean,
): Generator<{ data: string } | { rest: string }> {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = flush ? '' : (blocks.pop() ?? '');
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) yield { data };
  }
  yield { rest };
}

/** Yields validated events. Throws ApiError if an event is not JSON or fails the schema. */
export async function* readSseEvents<T>(
  response: Response,
  schema: ZodType<T>,
): AsyncGenerator<T> {
  if (!response.body) {
    throw new ApiError('BAD_RESPONSE', 'The server sent an empty response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let rest = buffer;
      for (const item of parseSseBlocks(buffer, done)) {
        if ('rest' in item) {
          rest = item.rest;
        } else {
          yield parseEvent(item.data, schema);
        }
      }
      buffer = rest;
      if (done) return;
    }
  } finally {
    // Stops the download when the consumer stops early (cancelled request, unmounted view).
    await reader.cancel().catch(() => undefined);
  }
}

function parseEvent<T>(data: string, schema: ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new ApiError('BAD_RESPONSE', 'The server sent an unreadable update.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('BAD_RESPONSE', 'The server sent an unexpected update.');
  }
  return parsed.data;
}
