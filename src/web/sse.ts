// Reads a Server-Sent Events stream from a fetch() response. EventSource cannot POST, so the
// browser client parses the byte stream itself. Only `data:` lines matter to our contract: each
// event is one JSON object carrying its own `type`.
import type { ZodType } from 'zod';

export const LOST = 'The connection to the server was lost. Please try again.';
/** The server sends a heartbeat every 15 s, so 45 s of silence means three missed beats. */
export const DEFAULT_IDLE_MS = 45_000;

export interface SseOptions {
  /** Abort if no bytes at all (events or heartbeat comments) arrive for this long. */
  idleMs?: number;
}

export const CUT_OFF = 'The answer was cut off. Please try again.';

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
  options: SseOptions = {},
): AsyncGenerator<T> {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  if (!response.body) {
    throw new ApiError('BAD_RESPONSE', 'The server sent an empty response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // A chunk may end between the \r and \n of one CRLF; hold the \r back so it is not read as a
  // line break of its own.
  let heldCr = false;
  try {
    for (;;) {
      const { done, value } = await readWithin(reader, idleMs);
      let text: string =
        (heldCr ? '\r' : '') + decoder.decode(value, { stream: !done });
      heldCr = !done && text.endsWith('\r');
      if (heldCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      let rest = buffer;
      // At end of stream, an unterminated final event may simply have been cut off.
      const cutOff = done && buffer.trim() !== '' && !buffer.endsWith('\n\n');
      const items = [...parseSseBlocks(buffer, done)];
      for (const [i, item] of items.entries()) {
        if ('rest' in item) {
          rest = item.rest;
        } else if (cutOff && i === items.length - 2) {
          yield parseFinalEvent(item.data, schema);
        } else {
          yield parseEvent(item.data, schema);
        }
      }
      buffer = rest;
      if (done) return;
    }
  } finally {
    // Stops the download when the consumer stops early (cancelled request, unmounted view).
    void reader.cancel().catch(() => undefined);
  }
}

/** One read that gives up after `ms` of silence; every new chunk starts a fresh wait. */
async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(new ApiError('STREAM_LOST', LOST));
    }, ms);
  });
  try {
    return await Promise.race([reader.read(), silence]);
  } finally {
    clearTimeout(handle);
  }
}

/** Like parseEvent, but unreadable JSON here means the stream ended mid-event. */
function parseFinalEvent<T>(data: string, schema: ZodType<T>): T {
  try {
    JSON.parse(data);
  } catch {
    throw new ApiError('BAD_RESPONSE', CUT_OFF);
  }
  return parseEvent(data, schema);
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
