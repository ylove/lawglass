/**
 * The Hono app: the /api routes from core/model/api.ts plus the built web UI. All pipeline work
 * (ingest, ask, excerpts) is delegated to core/pipeline; this layer only does HTTP, SSE framing,
 * public-mode policy and error mapping.
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import packageJson from '../../package.json' with { type: 'json' };
import type { CliRuntime } from '../cli/runtime.js';
import { BRAND, envVar } from '../core/brand.js';
import {
  AppError,
  AskRequest,
  CandidateLink,
  DocSummary,
  IngestRequest,
  isAppError,
  type AskEvent,
  type ClientConfig,
  type ErrorPayload,
  type IngestEvent,
} from '../core/model/index.js';
import { parsePdf as defaultParsePdf } from '../core/parse/index.js';
import { readParseLimits } from '../core/parse/limits.js';
import { ask, ingest, sectionExcerpt } from '../core/pipeline/index.js';
import type { RegistryEntry } from '../core/registry.js';
import { buildDocDetail } from './doc-detail.js';
import { CHIP_LABELS } from './chips.js';
import { SlidingWindowLimiter } from './rate-limit.js';
import { registerScenarioRoute } from './scenario-route.js';
import { createSummaryService } from './summary.js';
import { securityHeaders } from './security-headers.js';
import { staticAssets } from './static.js';
import { noopTurnstile, type TurnstileVerifier } from './turnstile.js';
import { isLoopbackHost } from './bind.js';
import {
  checkIngestFetchHost,
  checkIngestHost,
  ingestHosts,
} from './ingest-hosts.js';
import { createLogger, type LogWriter } from './log.js';
import { createSessionToken, localSession, readAccessKey } from './session.js';

export interface PublicLimits {
  questionsPerHour: number;
  ingestsPerHour: number;
  /** PDFs longer than this are refused before anything is embedded. */
  maxPages: number;
  /** Total documents the server will hold; ingests beyond it are refused, never evicting others. */
  maxDocs: number;
}

/** The document cap comes from the runtime configuration unless explicitly overridden. */
export const DEFAULT_PUBLIC_LIMITS: Omit<PublicLimits, 'maxDocs'> = {
  questionsPerHour: 20,
  ingestsPerHour: 3,
  maxPages: 200,
};

export interface AppOptions {
  publicMode?: boolean;
  privateMode?: boolean;
  accessKey?: string;
  publicOrigin?: string;
  ingestHosts?: ReadonlySet<string>;
  ingestDeadlineMs?: number;
  summaryWaitMs?: number;
  logWriter?: LogWriter;
  /** Directory holding the built web UI (dist/web). Omit to serve the API only. */
  webRoot?: string;
  limits?: Partial<PublicLimits>;
  turnstile?: TurnstileVerifier;
  /** Heartbeat comment interval for SSE streams. Default 15 s. */
  heartbeatMs?: number;
  /** Override how the client's address is found (tests, unusual proxies). */
  clientIp?: (c: Context) => string;
  /** Number of trusted proxies, counted from the right of X-Forwarded-For. */
  trustProxyHops?: number;
  /** Reject requests whose Host is not loopback (DNS-rebinding defence). Default: not public. */
  localOnly?: boolean;
  /** Launch token; generated when omitted. Ignored in public mode. */
  sessionToken?: string | undefined;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
const GENERIC_ERROR = 'Something went wrong. Please try again.';

const STATUS: Partial<Record<AppError['code'], 400 | 403 | 404 | 429>> = {
  INVALID_INPUT: 400,
  SSRF_BLOCKED: 400,
  UNSUPPORTED_FORMAT: 400,
  DOC_NOT_FOUND: 404,
  PUBLIC_MODE_FORBIDDEN: 403,
  DOC_CAP_REACHED: 403,
  RATE_LIMITED: 429,
};

/** Only an AppError's plain-language message may reach the client; anything else is generic. */
export function toErrorPayload(error: unknown): ErrorPayload {
  return isAppError(error)
    ? { code: error.code, message: error.userMessage }
    : { code: 'INTERNAL', message: GENERIC_ERROR };
}

function invalid(userMessage: string): AppError {
  return new AppError('INVALID_INPUT', userMessage, { userMessage });
}

export function createApp(runtime: CliRuntime, options: AppOptions = {}): Hono {
  const publicMode = options.publicMode ?? false;
  const privateMode = options.privateMode ?? false;
  if (privateMode && publicMode)
    throw invalid('--private and --public cannot be used together.');
  const hosted = publicMode || privateMode;
  const hosts = options.ingestHosts ?? ingestHosts();
  const hops = options.trustProxyHops ?? 0;
  if (!Number.isSafeInteger(hops) || hops < 0)
    throw invalid(
      '--trust-proxy must be a whole number of hops, 0 or greater.',
    );
  const limits: PublicLimits = {
    ...DEFAULT_PUBLIC_LIMITS,
    maxDocs: runtime.maxDocs,
    ...options.limits,
  };
  const turnstile = options.turnstile ?? noopTurnstile;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const now = options.now ?? Date.now;
  const questions = new SlidingWindowLimiter(
    limits.questionsPerHour,
    HOUR_MS,
    now,
  );
  const ingests = new SlidingWindowLimiter(limits.ingestsPerHour, HOUR_MS, now);
  let ingestsInFlight = 0;

  const clientIp =
    options.clientIp ??
    ((c: Context): string => {
      if (hops > 0) {
        const entries = c.req.header('x-forwarded-for')?.split(',');
        const forwarded =
          entries && entries.length >= hops
            ? entries[entries.length - hops]?.trim()
            : undefined;
        if (forwarded) return forwarded;
      }
      try {
        return getConnInfo(c).remote.address ?? 'unknown';
      } catch {
        return 'unknown';
      }
    });

  const app = new Hono();

  // First, so its headers also land on responses that later middleware returns early.
  app.use('*', securityHeaders({ publicMode, privateMode }));

  const log = createLogger(options.logWriter, now);
  app.use('*', log.middleware);

  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if ((options.localOnly ?? !hosted) && !isLoopbackHost(host))
      return c.json(
        { error: { code: 'INVALID_INPUT', message: 'Unexpected host.' } },
        403,
      );
    // Browsers attach Origin to cross-site writes; only our own pages may call the API.
    const origin = c.req.header('origin');
    if (origin && c.req.path.startsWith('/api/')) {
      let originHost = '';
      let requestHost = host;
      try {
        originHost = new URL(origin).host;
        requestHost = new URL(`http://${host}`).host;
      } catch {
        /* treated as a mismatch below */
      }
      if (originHost !== requestHost)
        return c.json(
          {
            error: { code: 'INVALID_INPUT', message: 'Cross-origin request.' },
          },
          403,
        );
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    const method = c.req.method;
    const canSpendOrChange =
      method === 'POST' ||
      method === 'DELETE' ||
      // HEAD reaches the GET handler, so it can start the same paid generation.
      ((method === 'GET' || method === 'HEAD') &&
        /^\/api\/docs\/[^/]+\/summary$/.test(c.req.path));
    if (canSpendOrChange && c.req.header('sec-fetch-site') === 'cross-site')
      return c.json(
        { error: { code: 'INVALID_INPUT', message: 'Cross-site request.' } },
        403,
      );
    if (
      method === 'POST' &&
      c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
    )
      return c.json(
        {
          error: {
            code: 'INVALID_INPUT',
            message: 'Content-Type must be application/json.',
          },
        },
        415,
      );
    await next();
  });

  if (!publicMode) {
    const token = privateMode
      ? readAccessKey(
          options.accessKey === undefined
            ? process.env
            : { [envVar('ACCESS_KEY')]: options.accessKey },
        )
      : (options.sessionToken ?? createSessionToken());
    const publicOrigin =
      options.publicOrigin ?? process.env[envVar('PUBLIC_ORIGIN')];
    app.use(
      '*',
      localSession(token, {
        privateMode,
        ...(options.webRoot ? { webRoot: options.webRoot } : {}),
        ...(publicOrigin ? { publicOrigin } : {}),
      }),
    );
  }

  const limitPostBody: MiddlewareHandler = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) =>
      c.json(
        {
          error: { code: 'TOO_LARGE', message: 'Request body exceeds 16 KB.' },
        },
        413,
      ),
  });
  const postBodyLimit: MiddlewareHandler = (c, next) =>
    c.req.method === 'POST' ? limitPostBody(c, next) : next();
  app.use('/api/*', postBodyLimit);

  app.onError((error, c) => {
    if (isAppError(error))
      return c.json(
        { error: toErrorPayload(error) },
        STATUS[error.code] ?? 500,
      );
    return c.json({ error: toErrorPayload(error) }, 500);
  });

  app.get('/api/health', (c) =>
    c.json({ ok: true as const, version: packageJson.version }),
  );

  app.get('/api/config', (c) => {
    // The provider may be unconfigured (no API key yet); the UI still needs to load.
    let provider = 'none';
    let model = '';
    try {
      ({ id: provider, model } = runtime.answerProvider);
    } catch {
      /* reported when a question is asked */
    }
    const config: ClientConfig = {
      productName: BRAND.displayName,
      publicMode,
      freeformEnabled: !publicMode,
      backend: runtime.backend.kind,
      provider,
      model,
      chips: CHIP_LABELS,
      scenariosEnabled: !publicMode,
      // Served once Section by section lands (#276).
      breakdownEnabled: false,
      // Served once Find where it says that lands (#295).
      locateEnabled: false,
    };
    return c.json(config);
  });

  const summaries = async (): Promise<DocSummary[]> => {
    const entries = await runtime.registry.list();
    return entries
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .map((e) => DocSummary.parse(e));
  };

  app.get('/api/docs', async (c) => c.json(await summaries()));

  const entryFor = async (docId: string): Promise<RegistryEntry> => {
    const entry = (await runtime.registry.list()).find(
      (e) => e.docId === docId,
    );
    if (!entry) throw new AppError('DOC_NOT_FOUND');
    return entry;
  };

  app.get('/api/docs/:docId', async (c) => {
    const entry = await entryFor(c.req.param('docId'));
    const doc = await runtime.registry.getDocument(entry.docId);
    return c.json(await buildDocDetail(runtime, DocSummary.parse(entry), doc));
  });

  const summary = createSummaryService(runtime, {
    publicMode,
    now,
    waitMs: options.summaryWaitMs,
  });

  // Cache-only in public mode and never rate limited: a public visitor cannot start a model
  // call here, so there is nothing to meter.
  app.get('/api/docs/:docId/summary', async (c) => {
    const entry = await entryFor(c.req.param('docId'));
    return c.json(
      await summary.get(entry.docId, {
        wait: c.req.method !== 'HEAD',
        signal: c.req.raw.signal,
        onError: (error, ms) => {
          log.error(c, error, ms);
        },
      }),
    );
  });

  app.delete('/api/docs/:docId', async (c) => {
    // Public servers share one library; visitors must not be able to wipe each other's documents.
    if (publicMode) throw new AppError('PUBLIC_MODE_FORBIDDEN');
    const entry = await entryFor(c.req.param('docId'));
    if (entry.backend === runtime.backend.kind) {
      await runtime.backend.deleteDocument(entry.docId);
    }
    await runtime.registry.remove(entry.docId);
    return c.body(null, 204);
  });

  app.get('/api/docs/:docId/sections/:sectionId', async (c) => {
    const entry = await entryFor(c.req.param('docId'));
    const doc = await runtime.registry.getDocument(entry.docId);
    try {
      return c.json(sectionExcerpt(doc, c.req.param('sectionId')));
    } catch (error) {
      if (isAppError(error) && error.code === 'INVALID_INPUT')
        return c.json({ error: toErrorPayload(error) }, 404);
      throw error;
    }
  });

  /**
   * Streams events as `data: <json>` frames with a heartbeat comment, and cancels `run`'s signal
   * when the client goes away. Failures become a final `error` event with the user-safe message.
   */
  function sse<E extends { type: string }>(
    c: Context,
    run: (emit: (event: E) => void, signal: AbortSignal) => Promise<void>,
    errorEvent: (error: ErrorPayload) => E,
    /** Called once the stream is over, whatever the outcome. */
    release: () => void = () => undefined,
    deadlineMs?: number,
  ): Response {
    c.header('x-accel-buffering', 'no');
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      stream.onAbort(abort);
      c.req.raw.signal.addEventListener('abort', abort);
      // Parsing, document lookup and public checks may finish after the client disconnects.
      if (c.req.raw.signal.aborted || stream.aborted) abort();
      const started = now();
      const deadline = new AbortController();
      const deadlineError = new AppError(
        'TOO_LARGE',
        'Ingest deadline exceeded.',
        {
          userMessage:
            'This bill took too long to process. Try a link to a specific version, or try again later.',
        },
      );
      const timer =
        deadlineMs === undefined
          ? undefined
          : setTimeout(() => {
              // Indexing already in progress finishes in the background until #221
              // adds cancellation to the backend contract.
              deadline.abort(deadlineError);
            }, deadlineMs);
      const signal = AbortSignal.any([controller.signal, deadline.signal]);
      const heartbeat = setInterval(() => {
        stream.write(': ping\n\n').catch(() => undefined);
      }, heartbeatMs);
      let tail: Promise<unknown> = Promise.resolve();
      // Events are queued so concurrent callbacks cannot interleave their frames.
      let accepting = true;
      const emit = (event: E): void => {
        if (!accepting || controller.signal.aborted) return;
        tail = tail
          .then(() => stream.writeSSE({ data: JSON.stringify(event) }))
          .catch(() => undefined);
      };
      try {
        controller.signal.throwIfAborted();
        // Race the signal as well: an injected or stuck dependency may ignore cancellation.
        await new Promise<void>((resolve, reject) => {
          const aborted = (): void => {
            const reason: unknown = signal.reason;
            reject(
              reason instanceof Error ? reason : new Error('Request aborted.'),
            );
          };
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
          else
            run(emit, signal)
              .then(resolve, reject)
              .finally(() => {
                signal.removeEventListener('abort', aborted);
              })
              .catch(() => undefined);
        });
      } catch (error) {
        // Nobody is listening after an abort, so there is nobody to tell.
        if (!controller.signal.aborted) {
          const failure = deadline.signal.aborted ? deadlineError : error;
          log.error(c, failure, now() - started);
          emit(errorEvent(toErrorPayload(failure)));
        }
      } finally {
        accepting = false;
        clearInterval(heartbeat);
        clearTimeout(timer);
        c.req.raw.signal.removeEventListener('abort', abort);
        release();
        await tail;
      }
    });
  }

  async function parseBody<T>(
    c: Context,
    schema: z.ZodType<T>,
    message: string,
  ): Promise<T> {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw invalid(message);
    return parsed.data;
  }

  /** Public-mode gate shared by the two expensive endpoints. */
  async function guardPublic(
    c: Context,
    limiter: SlidingWindowLimiter,
    token: string | undefined,
  ): Promise<void> {
    if (!publicMode) return;
    const ip = clientIp(c);
    if (!(await turnstile(token, ip)))
      throw new AppError('PUBLIC_MODE_FORBIDDEN', 'Turnstile check failed.', {
        userMessage: 'The bot check failed. Reload the page and try again.',
      });
    if (!limiter.take(ip)) throw new AppError('RATE_LIMITED');
  }

  app.post('/api/ingest', async (c) => {
    const body = await parseBody(
      c,
      IngestRequest,
      'Enter a full web address, starting with http:// or https://.',
    );
    // `z.url()` accepts any scheme. Only the CLI may read local files; a web request naming
    // `file:` (or anything else) must never reach a fetcher, so reject it before any stream.
    if (!/^https?:$/.test(new URL(body.url).protocol))
      throw new AppError('INVALID_INPUT', 'Ingest URL is not http(s).', {
        userMessage:
          'Enter a full web address, starting with http:// or https://.',
      });
    if (hosted) checkIngestHost(body.url, hosts);
    await guardPublic(c, ingests, body.turnstileToken);
    if (
      publicMode &&
      (await runtime.registry.list()).length + ingestsInFlight >= limits.maxDocs
    )
      throw new AppError('DOC_CAP_REACHED');

    // Resource policy reaches both the default parser and runtime-injected parsers.
    const parsePdf = runtime.parsePdf ?? defaultParsePdf;
    ingestsInFlight++;
    const started = now();
    let finished = false;
    const sourceHost = new URL(body.url).hostname;
    log.event(c, {
      level: 'info',
      event: 'ingest_start',
      status: 200,
      host: sourceHost,
      ms: 0,
    });
    return sse<IngestEvent>(
      c,
      async (emit, signal) => {
        try {
          const result = await ingest(
            body.url,
            {
              backend: runtime.backend,
              provider: runtime.extractProvider,
              registry: runtime.registry,
              fetcher: hosted
                ? async (url, options) => {
                    const validateUrl = (url: URL): void => {
                      checkIngestFetchHost(url, hosts);
                      options?.validateUrl?.(url);
                    };
                    validateUrl(new URL(url));
                    const result = await runtime.fetcher(url, {
                      ...options,
                      validateUrl,
                    });
                    validateUrl(new URL(result.finalUrl));
                    return result;
                  }
                : runtime.fetcher,
              now: runtime.now,
              // Public servers never evict: a visitor must not push out someone else's document.
              maxDocs: publicMode ? limits.maxDocs : runtime.maxDocs,
              parseLimits: {
                ...readParseLimits(publicMode),
                ...(publicMode ? { maxPages: limits.maxPages } : {}),
              },
              parsePdf,
            },
            {
              ...(body.label === undefined ? {} : { label: body.label }),
              signal,
              onProgress: (p) => {
                emit({ type: 'progress', ...stripUndefined(p) });
              },
              // The reader sees a plain note; the operator sees why (#270).
              onDiagnostic: (d) => {
                log.event(c, {
                  level: 'warn',
                  event: d.event,
                  status: 200,
                  code: d.code,
                  host: sourceHost,
                  ms: now() - started,
                });
              },
            },
          );
          signal.throwIfAborted();
          finished = true;
          log.event(c, {
            level: 'info',
            event: 'ingest_finish',
            status: 200,
            docId: result.doc.docId,
            host: sourceHost,
            chunks: Object.values(result.stats.chunkCountsByType).reduce(
              (sum, count) => sum + count,
              0,
            ),
            ms: now() - started,
          });
          emit({ type: 'done', doc: result.doc, stats: result.stats });
        } catch (error) {
          if (isAppError(error) && error.code === 'WRAPPER_PAGE') {
            // Never auto-followed: the user picks which linked file to ingest.
            const links = z
              .array(CandidateLink)
              .safeParse(error.details?.links);
            emit({
              type: 'candidates',
              links: links.success ? links.data : [],
            });
            return;
          }
          throw error;
        }
      },
      (error) => ({ type: 'error', error }),
      () => {
        ingestsInFlight--;
        if (!finished)
          log.event(c, {
            level: 'info',
            event: 'ingest_finish',
            status: 200,
            host: sourceHost,
            ms: now() - started,
          });
      },
      hosted ? (options.ingestDeadlineMs ?? 15 * 60 * 1000) : undefined,
    );
  });

  app.post('/api/docs/:docId/ask', async (c) => {
    const body = await parseBody(
      c,
      AskRequest,
      'Choose a question or type one (up to 500 characters).',
    );
    if (publicMode && body.question !== undefined)
      throw new AppError('PUBLIC_MODE_FORBIDDEN');
    const entry = await entryFor(c.req.param('docId'));
    await guardPublic(c, questions, body.turnstileToken);

    return sse<AskEvent>(
      c,
      async (emit, signal) => {
        const result = await ask(
          entry.docId,
          body.chipId === undefined
            ? { question: body.question ?? '' }
            : { chipId: body.chipId },
          {
            backend: runtime.backend,
            provider: runtime.answerProvider,
            registry: runtime.registry,
            retrievalMode: runtime.retrievalMode,
            chips: runtime.chips,
            // Public servers make no extra model call for a visitor's story.
            scenario: { enabled: !publicMode },
          },
          {
            signal,
            deferScenario: true,
            onToken: (text) => {
              emit({ type: 'token', text });
            },
          },
        );
        emit({
          type: 'retrieval',
          mode: result.mode,
          refs: result.refs,
          latencyMs: result.latencyMs,
        });
        // Event order: token* (while writing), retrieval, done, then scenario (only when one was
        // made). The answer is complete at `done`, so it never waits for the scenario; the
        // scenario is generated afterwards (bounded by its own timeout) and sent before the
        // stream closes. `done.answer` carries no scenario. Clients must keep reading after
        // `done` (#131 renders the late event).
        emit({ type: 'done', answer: result.answer });
        const scenario = await result.scenario;
        if (scenario) emit({ type: 'scenario', scenario });
      },
      (error) => ({ type: 'error', error }),
    );
  });

  registerScenarioRoute(app, runtime, { publicMode, now });

  app.all('/api/*', (c) =>
    c.json(
      { error: { code: 'DOC_NOT_FOUND', message: 'No such endpoint.' } },
      404,
    ),
  );

  if (options.webRoot) app.use('*', staticAssets(options.webRoot));

  return app;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
