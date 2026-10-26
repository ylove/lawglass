import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { BriefRegenerationEvent } from '../core/breakdown/generate.js';
import type { AnswerLogEvent } from '../core/answer/log.js';
import type { PictureLogEvent } from './pictures.js';
import { providerStatusOf } from '../core/llm/shared.js';
import { isAppError } from '../core/model/index.js';

export type LogWriter = (line: string) => void;
interface EventFields {
  level: 'info' | 'warn' | 'error';
  event:
    | 'refusal'
    | 'internal_error'
    | 'ingest_start'
    | 'ingest_finish'
    | 'metadata_failed'
    | 'excerpt_talk_dropped'
    | 'excerpt_talk_reworded'
    | 'regeneration_refused';
  status: number;
  code?: string;
  ms: number;
  errorName?: string;
  docId?: string;
  host?: string;
  chunks?: number;
  /** Sentences removed or reworded (excerpt_talk_dropped, excerpt_talk_reworded). */
  count?: number;
  /** The provider's HTTP status when a model call failed (#341); a number, never its message. */
  providerStatus?: number;
}

/** Only explicit fields cross this boundary. Error messages and request URLs never do. */
export function createLogger(
  write: LogWriter = (line) => {
    process.stderr.write(line);
  },
  now: () => number = Date.now,
) {
  /** Maps an answer-layer event to a log line. Codes and counts only, never model text. */
  function answerEvent(c: Context, e: AnswerLogEvent, ms: number): void {
    event(
      c,
      e.event === 'regeneration_refused'
        ? { level: 'info', event: e.event, status: 200, code: e.reason, ms }
        : { level: 'info', event: e.event, status: 200, count: e.count, ms },
    );
  }
  /** Same, for background work (the cached summary) that has no request behind it. */
  function backgroundAnswerEvent(e: AnswerLogEvent): void {
    write(
      JSON.stringify({
        t: new Date(now()).toISOString(),
        level: 'info',
        status: 200,
        ms: 0,
        ...(e.event === 'regeneration_refused'
          ? { event: e.event, code: e.reason }
          : { event: e.event, count: e.count }),
        route: '/api/docs/:docId/summary',
        method: 'GET',
      }) + '\n',
    );
  }
  function backgroundBreakdownEvent(e: BriefRegenerationEvent): void {
    write(
      JSON.stringify({
        t: new Date(now()).toISOString(),
        level: 'info',
        status: 200,
        ms: 0,
        event: e.event,
        rewritten: e.rewritten,
        refused: e.refused,
        route: '/api/docs/:docId/breakdown',
        method: 'GET',
      }) + '\n',
    );
  }
  function event(c: Context, fields: EventFields): void {
    write(
      JSON.stringify({
        t: new Date(now()).toISOString(),
        ...fields,
        route: routePath(c) || '*',
        method: c.req.method,
      }) + '\n',
    );
  }
  function error(c: Context, failure: unknown, ms: number): void {
    if (isAppError(failure)) {
      const providerStatus = providerStatusOf(failure);
      event(c, {
        level: 'warn',
        event: 'refusal',
        status: c.res.status,
        code: failure.code,
        ...(providerStatus === undefined ? {} : { providerStatus }),
        ms,
      });
    } else {
      // Error.name is mutable too; do not let a provider put credentials in that field.
      const name =
        failure instanceof TypeError
          ? 'TypeError'
          : failure instanceof RangeError
            ? 'RangeError'
            : 'Error';
      event(c, {
        level: 'error',
        event: 'internal_error',
        status: c.res.status,
        code: 'INTERNAL',
        errorName: name,
        ms,
      });
    }
  }
  const middleware: MiddlewareHandler = async (c, next) => {
    const start = now();
    await next();
    if (c.error) {
      error(c, c.error, now() - start);
      return;
    }
    if (
      [401, 403, 413, 415, 429].includes(c.res.status) ||
      c.res.status >= 400
    ) {
      // Read only server-generated JSON error codes. No message/body is sent to the writer.
      const payload: unknown = await c.res
        .clone()
        .json()
        .catch(() => undefined);
      const code = safeCode(payload);
      event(c, {
        level: 'warn',
        event: 'refusal',
        status: c.res.status,
        ...(code ? { code } : {}),
        ms: now() - start,
      });
    }
  };
  /** What a background picture run drew or refused (#344). Counts only, never text. */
  function pictureEvent(e: PictureLogEvent): void {
    write(
      JSON.stringify({
        t: new Date(now()).toISOString(),
        level: 'info',
        event: e.event,
        status: 200,
        count: e.count,
        ms: 0,
        route: `/api/docs/:docId/${e.source}/pictures`,
        method: 'GET',
      }) + '\n',
    );
  }
  /** A U.S. Code reference that could not be read at ingest. Only a citation and a code. */
  function referenceSkipped(citation: string, code: string): void {
    write(
      JSON.stringify({
        t: new Date(now()).toISOString(),
        level: 'warn',
        event: 'reference_skipped',
        citation: /^\d{1,2} U\.S\.C\. [\w-]{1,20}$/.test(citation)
          ? citation
          : 'unknown',
        code: /^[A-Z_]{1,40}$/.test(code) ? code : 'ERROR',
      }) + '\n',
    );
  }
  return {
    event,
    answerEvent,
    backgroundAnswerEvent,
    backgroundBreakdownEvent,
    pictureEvent,
    error,
    middleware,
    referenceSkipped,
  };
}

function safeCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('error' in payload))
    return undefined;
  const error = payload.error;
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  // Codes originate in our HTTP layer, never in the submitted request.
  return typeof error.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code)
    ? error.code
    : undefined;
}
