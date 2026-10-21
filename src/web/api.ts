// Typed client for the HTTP API described in src/core/model/api.ts. Every response and every
// stream event is validated with the shared zod schemas before the UI sees it.
/// <reference types="vite/client" />
import { z } from 'zod';
import {
  AskEvent,
  ClientConfig,
  DocDetail,
  DocSummary,
  IngestEvent,
  ScenarioResponse,
  SectionExcerpt,
  SummaryResponse,
  type AskRequest,
  type IngestRequest,
  type ScenarioRequest,
} from '../core/model/index.js';
import { createMockApi } from './mock-api.js';
import {
  ApiError,
  DEFAULT_IDLE_MS,
  readSseEvents,
  type SseOptions,
} from './sse.js';

export { ApiError } from './sse.js';

export interface ApiClient {
  /** True for the scripted in-browser mock, so the UI can show demo hints. */
  readonly mock?: boolean;
  getConfig(): Promise<ClientConfig>;
  listDocs(): Promise<DocSummary[]>;
  getDoc(docId: string): Promise<DocDetail>;
  removeDoc(docId: string): Promise<void>;
  getSection(docId: string, sectionId: string): Promise<SectionExcerpt>;
  /** The summary shown on arrival: cached, still being made (poll again), or off. */
  getSummary(docId: string): Promise<SummaryResponse>;
  /** An illustrated example for a subject the reader names (`POST .../scenario`). */
  getScenario(
    docId: string,
    req: ScenarioRequest,
    signal?: AbortSignal,
  ): Promise<ScenarioResponse>;
  ingest(req: IngestRequest, signal?: AbortSignal): AsyncIterable<IngestEvent>;
  ask(
    docId: string,
    req: AskRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AskEvent>;
}

export interface HttpApiOptions {
  baseUrl?: string;
  /** Injected in tests; defaults to the global fetch at call time. */
  fetchImpl?: typeof fetch;
  /** How long a JSON request may take before it fails with a plain message. */
  timeoutMs?: number;
  /** How long a stream may stay completely silent (heartbeats count as sound). */
  streamIdleMs?: number;
}

export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The summary endpoint long-polls on the server for up to 20 s, so it needs more room than an
 * ordinary request.
 */
export const SUMMARY_TIMEOUT_MS = 40_000;
export const TIMED_OUT =
  'The server took too long to answer. Please try again.';

const UNREACHABLE =
  'Could not reach the server. Check that it is running, then try again.';

/** Combines the caller's signal with ours; either one aborts the request. */
export function anySignal(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  // Older browsers: forward whichever fires first.
  const merged = new AbortController();
  const forward = (from: AbortSignal) => () => {
    merged.abort(from.reason);
  };
  for (const s of [a, b]) {
    if (s.aborted) merged.abort(s.reason);
    else s.addEventListener('abort', forward(s), { once: true });
  }
  return merged.signal;
}

export function createHttpApi(options: HttpApiOptions = {}): ApiClient {
  const base = options.baseUrl ?? '';
  const defaultTimeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sseOptions: SseOptions = {
    idleMs: options.streamIdleMs ?? DEFAULT_IDLE_MS,
  };

  /**
   * Runs `work` with a deadline. The deadline and the caller's signal both abort the fetch; a
   * deadline becomes a TIMEOUT error, a caller abort stays an AbortError.
   */
  async function withDeadline<T>(
    url: string,
    init: RequestInit | undefined,
    timeoutMs: number,
    work: (res: Response) => Promise<T>,
  ): Promise<T> {
    const timer = new AbortController();
    const deadline = { passed: false };
    const handle = setTimeout(() => {
      deadline.passed = true;
      timer.abort();
    }, timeoutMs);
    const callerSignal = init?.signal ?? undefined;
    try {
      const res = await (options.fetchImpl ?? fetch)(`${base}${url}`, {
        ...init,
        signal: anySignal(callerSignal, timer.signal),
      });
      return await work(res);
    } catch (cause: unknown) {
      if (deadline.passed) throw new ApiError('TIMEOUT', TIMED_OUT);
      if (cause instanceof ApiError) throw cause;
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        throw cause;
      }
      throw new ApiError('NETWORK', UNREACHABLE);
    } finally {
      clearTimeout(handle);
    }
  }

  function request<T>(
    url: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
    timeoutMs = defaultTimeout,
  ): Promise<T> {
    return withDeadline(url, init, timeoutMs, async (res) => {
      if (!res.ok) throw await errorFrom(res);
      const parsed = schema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        throw new ApiError(
          'BAD_RESPONSE',
          'The server sent an unexpected reply.',
        );
      }
      return parsed.data;
    });
  }

  async function* stream<T>(
    url: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): AsyncGenerator<T> {
    // The deadline covers only the wait for the first response (and any error body); after that the watchdog in
    // readSseEvents takes over, so a long answer is never cut short while bytes keep arriving.
    const res = await withDeadline(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
      sseOptions.idleMs ?? DEFAULT_IDLE_MS,
      // Reading an error body is still under the deadline, so a stalled 503 cannot hang.
      async (r) => {
        if (!r.ok) throw await errorFrom(r);
        return r;
      },
    );
    yield* readSseEvents(res, schema, sseOptions);
  }

  const docPath = (docId: string) => `/api/docs/${encodeURIComponent(docId)}`;

  return {
    getConfig: () => request('/api/config', ClientConfig),
    listDocs: () => request('/api/docs', z.array(DocSummary)),
    getDoc: (docId) => request(docPath(docId), DocDetail),
    getSummary: (docId) =>
      request(
        `${docPath(docId)}/summary`,
        SummaryResponse,
        undefined,
        Math.max(defaultTimeout, SUMMARY_TIMEOUT_MS),
      ),
    getScenario: (docId, req, signal) =>
      request(`${docPath(docId)}/scenario`, ScenarioResponse, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        ...(signal ? { signal } : {}),
      }),
    getSection: (docId, sectionId) =>
      request(
        `${docPath(docId)}/sections/${encodeURIComponent(sectionId)}`,
        SectionExcerpt,
      ),
    async removeDoc(docId) {
      await withDeadline(
        docPath(docId),
        { method: 'DELETE' },
        defaultTimeout,
        async (res) => {
          if (!res.ok) throw await errorFrom(res);
        },
      );
    },
    ingest: (req, signal) => stream('/api/ingest', req, IngestEvent, signal),
    ask: (docId, req, signal) =>
      stream(`${docPath(docId)}/ask`, req, AskEvent, signal),
  };
}

const ErrorBody = z.union([
  z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
  z.object({ code: z.string(), message: z.string() }),
]);

/** Turns a failed HTTP response into an ApiError with a message that is safe to show. */
async function errorFrom(res: Response): Promise<ApiError> {
  const parsed = ErrorBody.safeParse(await res.json().catch(() => null));
  if (parsed.success) {
    const e = 'error' in parsed.data ? parsed.data.error : parsed.data;
    return new ApiError(e.code, e.message);
  }
  return new ApiError(
    'HTTP_ERROR',
    `The server reported a problem (status ${String(res.status)}).`,
  );
}

/**
 * Mock mode: `?mock=1` in the URL, or VITE_MOCK_API at dev time. Dev builds only: a production
 * bundle must never let a visitor swap the real server for the scripted mock.
 */
export function selectApi(search: string, envFlag?: string): ApiClient {
  // Checked inline (not via a parameter) so the bundler folds it to `false` in production and
  // drops the mock API from the bundle entirely.
  if (import.meta.env.DEV) {
    const mock =
      new URLSearchParams(search).get('mock') === '1' ||
      (envFlag !== undefined && envFlag !== '' && envFlag !== '0');
    if (mock) return createMockApi({ publicMode: isPublicMock(search) });
  }
  return createHttpApi();
}

function isPublicMock(search: string): boolean {
  return new URLSearchParams(search).get('public') === '1';
}
