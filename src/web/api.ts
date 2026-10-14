// Typed client for the HTTP API described in src/core/model/api.ts. Every response and every
// stream event is validated with the shared zod schemas before the UI sees it.
import { z } from 'zod';
import {
  AskEvent,
  ClientConfig,
  DocDetail,
  DocSummary,
  IngestEvent,
  SectionExcerpt,
  SummaryResponse,
  type AskRequest,
  type IngestRequest,
} from '../core/model/index.js';
import { createMockApi } from './mock-api.js';
import { ApiError, readSseEvents } from './sse.js';

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
}

const UNREACHABLE =
  'Could not reach the server. Check that it is running, then try again.';

export function createHttpApi(options: HttpApiOptions = {}): ApiClient {
  const base = options.baseUrl ?? '';
  const send = (url: string, init?: RequestInit): Promise<Response> =>
    (options.fetchImpl ?? fetch)(`${base}${url}`, init).catch(
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          throw cause;
        }
        throw new ApiError('NETWORK', UNREACHABLE);
      },
    );

  async function request<T>(
    url: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T> {
    const res = await send(url, init);
    if (!res.ok) throw await errorFrom(res);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(
        'BAD_RESPONSE',
        'The server sent an unexpected reply.',
      );
    }
    return parsed.data;
  }

  async function* stream<T>(
    url: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): AsyncGenerator<T> {
    const res = await send(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw await errorFrom(res);
    yield* readSseEvents(res, schema);
  }

  const docPath = (docId: string) => `/api/docs/${encodeURIComponent(docId)}`;

  return {
    getConfig: () => request('/api/config', ClientConfig),
    listDocs: () => request('/api/docs', z.array(DocSummary)),
    getDoc: (docId) => request(docPath(docId), DocDetail),
    getSummary: (docId) =>
      request(`${docPath(docId)}/summary`, SummaryResponse),
    getSection: (docId, sectionId) =>
      request(
        `${docPath(docId)}/sections/${encodeURIComponent(sectionId)}`,
        SectionExcerpt,
      ),
    async removeDoc(docId) {
      const res = await send(docPath(docId), { method: 'DELETE' });
      if (!res.ok) throw await errorFrom(res);
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

/** Mock mode: `?mock=1` in the URL, or VITE_MOCK_API at build/dev time. */
export function selectApi(search: string, envFlag?: string): ApiClient {
  const mock =
    new URLSearchParams(search).get('mock') === '1' ||
    (envFlag !== undefined && envFlag !== '' && envFlag !== '0');
  return mock
    ? createMockApi({ publicMode: isPublicMock(search) })
    : createHttpApi();
}

function isPublicMock(search: string): boolean {
  return new URLSearchParams(search).get('public') === '1';
}
