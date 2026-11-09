/**
 * The Hono app: the /api routes from core/model/api.ts plus the built web UI. All pipeline work
 * (ingest, ask, excerpts) is delegated to core/pipeline; this layer only does HTTP, SSE framing,
 * public-mode policy and error mapping.
 */
import { randomUUID } from 'node:crypto';
import { deleteIndexedDocument } from '../core/answer/context.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import packageJson from '../../package.json' with { type: 'json' };
import type { CliRuntime } from '../cli/runtime.js';
import { BRAND, envVar } from '../core/brand.js';
import {
  AppError,
  AskRequest,
  type NormalizedDoc,
  CandidateLink,
  ClientConfig,
  DocSummary,
  IngestRequest,
  isAppError,
  type AskEvent,
  type ErrorPayload,
  type IngestEvent,
} from '../core/model/index.js';
import { parsePdf as defaultParsePdf } from '../core/parse/index.js';
import { readParseLimits } from '../core/parse/limits.js';
import { ask, ingest, sectionExcerpt } from '../core/pipeline/index.js';
import { fetchAndParseDocument } from '../core/pipeline/ingest.js';
import { sharedLimits } from '../core/pipeline/limits.js';
import {
  billFacts,
  newSpend,
  runInJob,
  type BillEstimate,
  type BillFacts,
  type FeatureEstimate,
  budgetRemaining,
  topUp,
  type JobKind,
  type JobScope,
  type ModelAssignment,
  type ModelChoice,
  type UsageEvent,
} from '../core/cost/index.js';
import type { RegistryEntry } from '../core/registry.js';
import { buildDocDetail } from './doc-detail.js';
import { CHIP_LABELS } from './chips.js';
import { getChip } from '../core/chips.js';
import { lazyProvider } from '../core/llm/lazy-provider.js';
import { SlidingWindowLimiter } from './rate-limit.js';
import { registerLocateRoute } from './locate-route.js';
import type {
  BreakdownMaxUnits,
  PregenerateExamples,
} from '../core/breakdown/coverage.js';
import { registerBreakdownRoutes } from './breakdown-route.js';
import { registerPictureRoutes } from './pictures-route.js';
import { registerScenarioRoute } from './scenario-route.js';
import { createSummaryService } from './summary.js';
import { securityHeaders, type CspExtensions } from './security-headers.js';
import { staticAssets, validateHead } from './static.js';
import { noopTurnstile, type TurnstileVerifier } from './turnstile.js';
import { isLoopbackHost } from './bind.js';
import {
  checkIngestFetchHost,
  checkIngestHost,
  ingestHosts,
} from './ingest-hosts.js';
import { createLogger, type LogWriter } from './log.js';
import {
  AdmissionRefused,
  interpretAdmission,
  type AdmissionHook,
  type BackgroundScopeHook,
  type SavedScope,
  type AdmissionJob,
  type ModelForHook,
} from './admission.js';
import { validBudget } from './admission.js';
import { routedRuntime } from './model-routing.js';
import {
  estimatesFor,
  QuoteRequest,
  questionEstimate,
  quoteFacts,
  QuoteStore,
  quoteTiers,
  type QuoteOptions,
} from './quotes.js';
import { readExamples } from './examples.js';
import {
  isReaderId,
  newReaderId,
  READER_COOKIE,
  READER_COOKIE_MAX_AGE_S,
  ReaderLibrary,
} from './readers.js';
import { gateAssets, quickstartHtml, type SiteOptions } from './gate.js';
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

export interface ExternalAuth {
  /** Runs after request safety checks and public pages, before any API or SPA work. */
  middleware: MiddlewareHandler;
  /** Stable, nonempty opaque account id. Never logged or stored in a cookie. */
  readerId: (c: Context) => string;
}

export interface AppOptions {
  auth?: ExternalAuth;
  /** A refusal deliberately looks exactly like an absent document, including for SSE routes. */
  canRead?: (c: Context, docId: string) => boolean | Promise<boolean>;
  csp?: CspExtensions;
  site?: SiteOptions;
  head?: string[];
  /** Same-origin account page; the SPA uses a normal link so the host handles navigation. */
  accountUrl?: string;
  /** Pinned documents count toward capacity but are never automatically removed. */
  pinned?: (docId: string) => boolean | Promise<boolean>;
  /**
   * Called before any request that would start paid model work (ADR 0018, section 3). A host
   * that returns `allow` for everyone has opened the server's model budget to every reader.
   */
  admission?: AdmissionHook;
  /** Every model call's usage with its job context, including background generation. */
  onUsage?: (event: UsageEvent) => void | Promise<void>;
  /** Chooses the answer and extract models for a job. Cache keys include the model. */
  modelFor?: ModelForHook;
  /**
   * Consulted when background work for a (document, tier) starts and no live scope exists (the
   * first request after a restart, a resumed run). Return the persisted REMAINING budget, models
   * and job id, or undefined when unknown, which means no paid work. Required with `admission`.
   */
  backgroundScope?: BackgroundScopeHook;
  /** Quote API settings and the plans admission estimates use. */
  quote?: QuoteOptions;
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
  /** Reject requests whose Host is not loopback (DNS-rebinding defence). Default: local mode only. */
  localOnly?: boolean;
  /** Launch token; generated when omitted. Ignored in public mode. */
  sessionToken?: string | undefined;
  /** Bound listener port; defaults to the runtime port when no listener is attached. */
  sessionPort?: () => number;
  /** Example bills for the homepage; defaults to the examples environment variable. */
  examples?: ClientConfig['examples'];
  /**
   * Full coverage (#382), both opt-in. Parts that get a brief: default `<PREFIX>_BREAKDOWN_MAX_UNITS`,
   * else 30; `'all'` briefs every substantive part.
   */
  breakdownMaxUnits?: BreakdownMaxUnits;
  /** Examples drawn ahead: default `<PREFIX>_PREGENERATE_EXAMPLES`, else `'small'` (1-8 parts). */
  pregenerateExamples?: PregenerateExamples;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
const GENERIC_ERROR = 'Something went wrong. Please try again.';

const STATUS: Partial<Record<AppError['code'], 400 | 402 | 403 | 404 | 429>> = {
  PAYMENT_REQUIRED: 402,
  BUDGET_EXHAUSTED: 403,
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

/** Chip strategies whose answer needs no model, or only an optional one. */
const LAZY_STRATEGIES: ReadonlySet<string> = new Set(['metadata', 'extract']);

export function createApp(
  rawRuntime: CliRuntime,
  options: AppOptions = {},
): Hono {
  // With model routing, services reading `runtime.answerProvider` get the model of the job in
  // scope (the tier an admitted ingest fixed for background generation).
  const runtime =
    options.modelFor || options.backgroundScope
      ? routedRuntime(rawRuntime)
      : rawRuntime;
  const publicMode = options.publicMode ?? false;
  const privateMode = options.privateMode ?? false;
  const configuredAuth: unknown = options.auth;
  if (
    configuredAuth !== undefined &&
    (typeof configuredAuth !== 'object' ||
      configuredAuth === null ||
      !('middleware' in configuredAuth) ||
      typeof configuredAuth.middleware !== 'function' ||
      !('readerId' in configuredAuth) ||
      typeof configuredAuth.readerId !== 'function')
  )
    throw invalid('External auth requires middleware and readerId functions.');
  const auth = options.auth;
  // Without it a restart would leave every document's background generation unbudgeted.
  if (options.admission && !options.backgroundScope)
    throw invalid(
      'admission requires backgroundScope: background generation needs a persisted budget.',
    );
  if (auth && (privateMode || publicMode))
    throw invalid(
      'External auth cannot be combined with privateMode or publicMode.',
    );
  for (const [name, hook] of Object.entries({
    canRead: options.canRead,
    pinned: options.pinned,
    admission: options.admission,
    backgroundScope: options.backgroundScope,
    onUsage: options.onUsage,
    modelFor: options.modelFor,
    landing: options.site?.landing,
    quickstart: options.site?.quickstart,
  })) {
    if (hook !== undefined && typeof hook !== 'function')
      throw invalid(`${name} must be a function.`);
  }
  // With external auth the host serves its own signed-out pages; a landing override would never
  // be reached, so refuse it rather than ignore it silently.
  if (auth && options.site?.landing)
    throw invalid(
      'site.landing is unused with external auth: serve the landing page from the host.',
    );
  validateHead(options.head);
  if (
    options.accountUrl !== undefined &&
    !ClientConfig.shape.accountUrl.safeParse(options.accountUrl).success
  )
    throw invalid('accountUrl must be a same-origin path starting with /.');
  if (privateMode && publicMode)
    throw invalid('--private and --public cannot be used together.');
  const hosted = publicMode || privateMode || auth !== undefined;
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
  // Documents with an ingest under way, with a count per document. They are never evicted or
  // reclaimed, and they count toward the public document cap exactly once.
  const holds = new Map<string, number>();
  // Capacity decisions (check, reclaim, reserve) run one at a time; the hosted server is a
  // single process, so a promise chain is enough.
  let capTail: Promise<unknown> = Promise.resolve();
  const withCapLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = capTail.then(task);
    capTail = run.catch(() => undefined);
    return run;
  };

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
  const logLine =
    options.logWriter ?? ((line: string) => process.stderr.write(line));
  const examples = options.examples ?? readExamples(process.env, logLine, now);
  // Hosted servers keep one document list per reader; local mode lists everything.
  const readers = hosted
    ? new ReaderLibrary(runtime.registry.configDir, {
        now: () => new Date(now()),
        externalIds: auth !== undefined,
      })
    : undefined;
  const readerOf = new WeakMap<Request, string>();
  // Requests that arrived without a valid cookie, so their reader id was minted just now.
  const freshReader = new WeakSet<Request>();

  // First, so its headers also land on responses that later middleware returns early.
  app.use(
    '*',
    securityHeaders({
      publicMode,
      privateMode,
      externalAuth: auth !== undefined,
      csp: options.csp,
    }),
  );

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
        /^\/api\/docs\/[^/]+\/(?:summary|breakdown|(?:summary|breakdown)\/pictures|sections\/[^/]+\/example)$/.test(
          c.req.path,
        ));
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

  // The quickstart is public in every mode and registered before the session check and the SPA
  // fallback, so neither gates nor swallows it. It contains no per-user data.
  app.on(['GET', 'HEAD'], '/quickstart', async (c, next) => {
    // A key in the query string still goes through the session exchange (and its redirect).
    if (!auth && c.req.query('k') !== undefined) return next();
    return c.html(
      await (options.site?.quickstart
        ? options.site.quickstart(c)
        : quickstartHtml(
            options.publicOrigin ?? process.env[envVar('PUBLIC_ORIGIN')],
            options.webRoot,
          )),
    );
  });

  const health = (c: Context): Response =>
    c.json({ ok: true as const, version: packageJson.version });
  // External hosts need credential-free liveness probes. Health carries no reader data and
  // stops before host middleware or reader setup, so it cannot create cookies or list files.
  if (auth) app.get('/api/health', health);

  if (auth) app.use('*', auth.middleware);
  else if (!publicMode) {
    const token = privateMode
      ? readAccessKey(
          options.accessKey === undefined
            ? process.env
            : { [envVar('ACCESS_KEY')]: options.accessKey },
        )
      : (options.sessionToken ?? createSessionToken());
    const publicOrigin =
      options.publicOrigin ?? process.env[envVar('PUBLIC_ORIGIN')];
    // Local mode has no gate page, but /quickstart still needs its stylesheet, fonts and images
    // before sign-in. Only the exact public allowlist is served; a ?k= request is left to the
    // session middleware so the key exchange keeps running first. (Private mode serves the same
    // allowlist from inside localSession, and public mode has no session at all.)
    if (!privateMode && options.webRoot) {
      const publicAssets = gateAssets(options.webRoot);
      const unlessKeyExchange: MiddlewareHandler = (c, next) =>
        c.req.query('k') === undefined ? publicAssets(c, next) : next();
      app.use('*', unlessKeyExchange);
    }
    app.use(
      '*',
      localSession(token, {
        port: options.sessionPort ?? runtime.port,
        privateMode,
        ...(options.webRoot ? { webRoot: options.webRoot } : {}),
        ...(publicOrigin ? { publicOrigin } : {}),
        ...(options.site?.landing ? { landing: options.site.landing } : {}),
      }),
    );
  }

  if (options.canRead) {
    const canRead = options.canRead;
    const checked = new WeakSet<Context>();
    const readAccess: MiddlewareHandler = async (c, next) => {
      // Some Hono routers match the wildcard on the base path too. Authorize only once.
      if (!checked.has(c)) {
        const docId = c.req.param('docId');
        if (!docId) throw new AppError('DOC_NOT_FOUND');
        // Untyped hosts must grant access explicitly; a truthy non-boolean is still a refusal.
        const allowed: unknown = await canRead(c, docId);
        if (allowed !== true) throw new AppError('DOC_NOT_FOUND');
        checked.add(c);
      }
      await next();
    };
    // Before body parsing, reader-list writes and every handler (including registered SSE routes).
    app.use('/api/docs/:docId', readAccess);
    app.use('/api/docs/:docId/*', readAccess);
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

  if (hosted) {
    // Runs after the session check, so a gated visitor never receives a reader id. The id only
    // keys the list; it grants no access (see readers.ts).
    const ensureReader: MiddlewareHandler = async (c, next) => {
      // Health checks are not a reader; they must stay cookie-free.
      if (c.req.path === '/api/health') return next();
      if (auth) {
        const id = auth.readerId(c);
        if (typeof id !== 'string' || id.length === 0)
          throw new Error('Invalid reader id.');
        readerOf.set(c.req.raw, id);
        return next();
      }
      const sent = getCookie(c, READER_COOKIE);
      let id = isReaderId(sent) ? sent : undefined;
      if (!id) {
        id = newReaderId();
        freshReader.add(c.req.raw);
        setCookie(c, READER_COOKIE, id, {
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
          path: '/',
          maxAge: READER_COOKIE_MAX_AGE_S,
        });
      }
      readerOf.set(c.req.raw, id);
      await next();
    };
    app.use('/api/*', ensureReader);
  }
  const readerId = (c: Context): string => {
    const id = readerOf.get(c.req.raw);
    if (!id) throw new Error('Reader id missing.');
    return id;
  };

  // --- hosting hooks: job scopes, admission, quotes (ADR 0018) --------------------------------
  const hooked =
    options.admission !== undefined ||
    options.onUsage !== undefined ||
    options.modelFor !== undefined ||
    options.backgroundScope !== undefined;
  const estimating =
    options.admission !== undefined || options.modelFor !== undefined;
  const quotes = new QuoteStore(now);
  // Per signed-in reader (auth and private modes), so one account cannot drive unbounded fetches.
  const readerQuotes = new SlidingWindowLimiter(
    options.quote?.perReaderPerHour ?? 60,
    HOUR_MS,
    now,
  );
  const readerIngests = new SlidingWindowLimiter(
    options.quote?.perReaderPerHour ?? 60,
    HOUR_MS,
    now,
  );
  const quoteLimiter = new SlidingWindowLimiter(
    options.quote?.perHour ?? 20,
    HOUR_MS,
    now,
  );
  // The scope of the first admitted ingest of each document. Background generation (summary,
  // breakdown, pictures, pre-drawn examples) runs under it, so one budget and one tier cover it.
  const docScopes = new Map<string, JobScope>();
  const DOC_SCOPE_CAP = 2000;
  const factsCache = new Map<string, BillFacts>();
  const FACTS_CACHE_CAP = 200;
  const readerFor = (c: Context): string => (hosted ? readerId(c) : 'local');

  /** The models this server is set up with; a missing key just means the built-in defaults price it. */
  const configuredModels = (): Partial<ModelAssignment> => {
    const configured: Partial<ModelAssignment> = {};
    try {
      configured.answerModel = rawRuntime.answerProvider.model;
    } catch {
      /* unconfigured */
    }
    try {
      configured.extractModel = rawRuntime.extractProvider.model;
    } catch {
      /* unconfigured */
    }
    return configured;
  };
  const tiers = (): Record<string, ModelAssignment> =>
    quoteTiers(options.quote, configuredModels);
  const defaultAssignment = (): ModelAssignment => firstOf(tiers());

  // --- generation scopes: one per (document, tier) -------------------------------------------
  const tierName = (models: ModelChoice | undefined): string =>
    `${models?.answer ?? 'default'}+${models?.extract ?? 'default'}`;
  const scopeKey = (docId: string, tier: string): string => `${docId}\n${tier}`;
  const installScope = (key: string, scope: JobScope): JobScope => {
    if (docScopes.size >= DOC_SCOPE_CAP) evictOldest(docScopes);
    docScopes.set(key, scope);
    // Someone just paid for this document: failures that happened while it was unpaid are over.
    resumeDoc(key.slice(0, key.indexOf('\n')));
    return scope;
  };
  /** Forget failure cool-downs and let budget-stopped runs go on, for a document just paid for. */
  function resumeDoc(docId: string): void {
    summary.resume?.(docId);
    breakdown.resume?.(docId);
    pictures.resume(docId);
  }
  /** Zero budget: every model call is refused, so only cached results are served. */
  const failClosed = (
    c: Context,
    docId: string,
    models: ModelChoice | undefined,
  ): JobScope =>
    makeScope(
      c,
      { kind: 'ingest', docId },
      { budget: { tokens: 0, dollars: 0 }, models },
    );

  const LOOKUP_TTL_MS = 60_000;
  const UNKNOWN_TTL_MS = 5_000;
  const LOOKUP_CAP = 2000;
  const lookups = new Map<
    string,
    { at: number; value: Promise<SavedScope | undefined> }
  >();
  /** The host's persisted scope for (document, tier), asked at most once a minute. */
  function lookupSaved(
    docId: string,
    tier: string,
    models: ModelChoice | undefined,
  ): Promise<SavedScope | undefined> {
    const key = scopeKey(docId, tier);
    const hit = lookups.get(key);
    if (hit && now() - hit.at < LOOKUP_TTL_MS) return hit.value;
    const hook = options.backgroundScope;
    if (!hook) return Promise.resolve(undefined);
    const value = Promise.resolve().then(() => hook(docId, tier, models));
    const entry = { at: now(), value };
    if (lookups.size >= LOOKUP_CAP) evictOldest(lookups);
    lookups.set(key, entry);
    // "Unknown" is remembered only briefly, so a host-side unlock takes effect within seconds.
    void value.then(
      (saved) => {
        if (saved === undefined && lookups.get(key) === entry)
          entry.at = now() - LOOKUP_TTL_MS + UNKNOWN_TTL_MS;
      },
      () => undefined,
    );
    // A failed lookup is not remembered: the next paid request asks again.
    value.catch(() => {
      if (lookups.get(key) === entry) lookups.delete(key);
    });
    return value;
  }

  function scopeFromSaved(
    c: Context,
    docId: string,
    saved: SavedScope,
    fallback: ModelChoice | undefined,
  ): JobScope {
    const budget = saved.budget;
    if (budget !== undefined && !validBudget(budget))
      throw new Error('Invalid job budget.');
    const scope = makeScope(
      c,
      { kind: 'ingest', docId },
      { budget, models: checkedChoice(saved.models) ?? fallback },
    );
    if (typeof saved.jobId === 'string' && saved.jobId.length > 0)
      scope.context.jobId = saved.jobId;
    return scope;
  }

  /** The tier the reader's work runs on: what `modelFor` resolves for them on this document. */
  async function readerModels(
    c: Context,
    docId: string,
  ): Promise<ModelChoice | undefined> {
    if (!options.modelFor) return undefined;
    const estimates = estimatesFor(
      await factsFor(docId),
      tiers(),
      options.quote,
    );
    return checkedChoice(
      options.modelFor(
        { kind: 'ingest', docId, estimate: firstOf(estimates), estimates },
        c,
      ),
    );
  }

  /**
   * The scope background work for (document, tier) runs in: the live one; else what the host
   * persisted (`backgroundScope`); else, when the host does not know it, a zero budget (cached
   * results only). Without the hook (no `admission` either) the requester stands in, as before.
   */
  async function resolveDocScope(c: Context, docId: string): Promise<JobScope> {
    let models: ModelChoice | undefined;
    try {
      models = await readerModels(c, docId);
    } catch {
      return options.admission
        ? failClosed(c, docId, undefined)
        : makeScope(c, { kind: 'ingest', docId }, {});
    }
    const tier = tierName(models);
    const key = scopeKey(docId, tier);
    const live = docScopes.get(key);
    if (live) return live;
    if (!options.backgroundScope)
      return makeScope(c, { kind: 'ingest', docId }, { models });
    let saved: SavedScope | undefined;
    try {
      saved = await lookupSaved(docId, tier, models);
    } catch {
      // A host outage stops paid work only; cached reads are still served.
      return failClosed(c, docId, models);
    }
    if (!saved)
      return options.admission
        ? failClosed(c, docId, models)
        : makeScope(c, { kind: 'ingest', docId }, { models });
    return (
      docScopes.get(key) ??
      installScope(key, scopeFromSaved(c, docId, saved, models))
    );
  }

  /** A host's model choice, kept only when it is a pair of nonempty strings. */
  const checkedChoice = (choice: unknown): ModelChoice | undefined => {
    if (typeof choice !== 'object' || choice === null) return undefined;
    const { answer, extract } = choice as ModelChoice;
    const ok = (m: unknown): m is string =>
      typeof m === 'string' && m.length > 0;
    return {
      ...(ok(answer) ? { answer } : {}),
      ...(ok(extract) ? { extract } : {}),
    };
  };

  const makeScope = (
    c: Context,
    job: { kind: JobKind; docId?: string | undefined },
    extra: { budget?: JobScope['budget']; models?: ModelChoice | undefined },
  ): JobScope => ({
    context: {
      readerId: readerFor(c),
      jobKind: job.kind,
      jobId: randomUUID(),
      ...(job.docId === undefined ? {} : { docId: job.docId }),
    },
    budget: extra.budget,
    models: extra.models,
    prices: options.quote?.prices,
    onUsage: options.onUsage,
    onBudgetExhausted: (spent) => {
      log.budgetExhausted(job.kind, spent.calls);
    },
    spent: newSpend(),
  });

  /** Forecasts need only the parsed document, which the registry already holds. */
  const factsFor = async (docId: string): Promise<BillFacts> => {
    const hit = factsCache.get(docId);
    if (hit) return hit;
    const doc = await runtime.registry.getDocument(docId);
    const facts = billFacts(doc.sections);
    if (factsCache.size >= FACTS_CACHE_CAP) evictOldest(factsCache);
    factsCache.set(docId, facts);
    return facts;
  };

  /** Asks the host, if it has an admission hook. A refusal throws `AdmissionRefused`. */
  const consult = async (
    c: Context,
    job: AdmissionJob,
  ): Promise<{ budget: JobScope['budget'] }> => {
    if (!options.admission) return { budget: undefined };
    const decision = interpretAdmission(await options.admission(c, job));
    if (!decision.allowed) throw new AdmissionRefused(decision.response);
    return { budget: decision.budget };
  };

  /**
   * Admission for a question, chip, locate, scenario or example, before any model call. Returns
   * the scope to run the work in, or undefined when no hook is installed. `exempt` work makes no
   * model call, so it is attributed but never admitted.
   */
  async function admitJob(
    c: Context,
    job: {
      kind: Exclude<JobKind, 'ingest'>;
      docId: string;
      chipId?: string | undefined;
      quoteId?: string | undefined;
    },
    opts: { exempt?: boolean } = {},
  ): Promise<JobScope | undefined> {
    if (!hooked) return undefined;
    // An example is drawn by the document's own tier so its cache key matches its brief's.
    const inherited =
      job.kind === 'example'
        ? (await resolveDocScope(c, job.docId)).models
        : undefined;
    if (opts.exempt || !estimating)
      return makeScope(c, job, { models: inherited });
    const facts = await factsFor(job.docId);
    const base = defaultAssignment();
    const estimateFor = (models: ModelChoice | undefined): FeatureEstimate =>
      questionEstimate(
        facts,
        {
          answerModel: models?.answer ?? base.answerModel,
          extractModel: models?.extract ?? base.extractModel,
        },
        options.quote,
      );
    const fields = {
      kind: job.kind,
      docId: job.docId,
      ...(job.chipId === undefined ? {} : { chipId: job.chipId }),
      ...(job.quoteId === undefined ? {} : { quoteId: job.quoteId }),
    };
    const models =
      job.kind !== 'example' && options.modelFor
        ? checkedChoice(
            options.modelFor(
              { ...fields, estimate: estimateFor(inherited) },
              c,
            ),
          )
        : inherited;
    const { budget } = await consult(c, {
      ...fields,
      tier: tierName(models),
      estimate: estimateFor(models),
    });
    return makeScope(c, job, { budget, models });
  }

  // Background generation runs under the scope of its (document, tier); see `resolveDocScope`.
  // Only routes that can start generation resolve it, and only once per request.
  if (hooked) {
    const GENERATES =
      /^\/api\/docs\/[^/]+\/(?:summary|breakdown|(?:summary|breakdown)\/pictures|sections\/[^/]+\/example)$/;
    const resolved = new WeakSet<Request>();
    const inDocScope: MiddlewareHandler = async (c, next) => {
      const docId = c.req.param('docId');
      if (
        (c.req.method !== 'GET' && c.req.method !== 'HEAD') ||
        !docId ||
        !GENERATES.test(c.req.path) ||
        resolved.has(c.req.raw)
      )
        return next();
      resolved.add(c.req.raw);
      await runInJob(await resolveDocScope(c, docId), next);
    };
    app.use('/api/docs/:docId', inDocScope);
    app.use('/api/docs/:docId/*', inDocScope);
  }

  app.onError((error, c) => {
    if (error instanceof AdmissionRefused) return error.response;
    if (isAppError(error))
      return c.json(
        { error: toErrorPayload(error) },
        STATUS[error.code] ?? 500,
      );
    return c.json({ error: toErrorPayload(error) }, 500);
  });

  if (!auth) app.get('/api/health', health);

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
      // Public servers never start a model call for a visitor, so there is nothing to show.
      breakdownEnabled: !publicMode,
      locateEnabled: !publicMode,
      library: hosted ? 'reader' : 'local',
      ...(examples && examples.length > 0 ? { examples } : {}),
      ...(options.accountUrl !== undefined
        ? { accountUrl: options.accountUrl }
        : {}),
    };
    return c.json(config);
  });

  const summaries = async (): Promise<DocSummary[]> => {
    const entries = await runtime.registry.list();
    return entries
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .map((e) => DocSummary.parse(e));
  };

  app.get('/api/docs', async (c) => {
    const all = await summaries();
    if (!readers) return c.json(all);
    // The reader's own list, newest use first. Documents evicted since simply drop out.
    const byId = new Map(all.map((d) => [d.docId, d]));
    return c.json(
      (await readers.list(readerId(c))).flatMap((r) => {
        const doc = byId.get(r.docId);
        return doc ? [{ ...doc, lastUsedAt: r.lastUsedAt }] : [];
      }),
    );
  });

  /** The list is a convenience: failing to save it must not fail the request that triggered it. */
  const rememberForReader = async (
    c: Context,
    docId: string,
    /** Opening a shared link is not worth a file on a public server: wait for a returning reader. */
    options: { skipFreshPublic?: boolean } = {},
  ): Promise<void> => {
    if (!readers) return;
    if (options.skipFreshPublic && publicMode && freshReader.has(c.req.raw))
      return;
    try {
      await readers.markUsed(readerId(c), docId);
    } catch (error) {
      log.error(c, error, 0);
    }
  };

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
    await rememberForReader(c, entry.docId, { skipFreshPublic: true });
    return c.json(await buildDocDetail(runtime, DocSummary.parse(entry), doc));
  });

  const summary = createSummaryService(runtime, {
    log: (e) => {
      log.backgroundAnswerEvent(e);
    },
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
    if (readers) {
      // Hosted servers share one store, so removing only takes the document off this reader's
      // list. Idempotent: an already evicted document is simply gone from the list too.
      await readers.remove(readerId(c), c.req.param('docId'));
      return c.body(null, 204);
    }
    const entry = await entryFor(c.req.param('docId'));
    if (entry.backend === runtime.backend.kind) {
      await deleteIndexedDocument(runtime.backend, entry.docId);
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
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.path[0] === 'quoteId'))
        throw invalid(
          'The quote id is not valid. Quote ids use only letters, digits, hyphens and underscores (up to 128).',
        );
      throw invalid(message);
    }
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

  /**
   * Admission for one ingest, called by the pipeline once the document id is known (so an
   * address that turns out to be a document we already hold is never refused). It protects the
   * document for the length of the request. On a public server at the cap, documents no reader
   * lists are reclaimed oldest first; if there are not enough, the ingest is refused.
   */
  function admitDocuments(held: Holds, signal: AbortSignal) {
    // Resolves to whether the document is stored now, which can differ from what the caller
    // saw before waiting for the lock (another admission may have reclaimed it meanwhile).
    return (docId: string): Promise<boolean> =>
      withCapLock(async () => {
        // A request that gave up, or whose holds were already released, must not take a
        // hold nobody would release.
        signal.throwIfAborted();
        if (held.closed)
          throw new AppError('INVALID_INPUT', 'Request finished.');
        if (!held.ids.has(docId)) {
          held.ids.add(docId);
          holds.set(docId, (holds.get(docId) ?? 0) + 1);
        }
        const entries = await runtime.registry.list();
        const stored = new Set(entries.map((e) => e.docId));
        if (!publicMode) return stored.has(docId);
        if (stored.has(docId)) return true;
        // Each document counts once: stored, or about to be (held but not stored yet).
        const unstored = [...holds.keys()].filter((id) => !stored.has(id));
        const excess = stored.size + unstored.length - limits.maxDocs;
        if (excess <= 0) return false;
        const listed = readers
          ? await readers.listedDocIds()
          : new Set<string>();
        // Other backends' entries are left alone: only their own backend can delete the index.
        const candidates = entries
          .filter(
            (e) =>
              !listed.has(e.docId) &&
              !holds.has(e.docId) &&
              e.backend === runtime.backend.kind,
          )
          .sort(
            (a, b) =>
              a.lastUsedAt.localeCompare(b.lastUsedAt) ||
              a.ingestedAt.localeCompare(b.ingestedAt) ||
              a.docId.localeCompare(b.docId),
          );
        const reclaimable: RegistryEntry[] = [];
        for (const entry of candidates) {
          if (options.pinned && (await options.pinned(entry.docId))) continue;
          reclaimable.push(entry);
          if (reclaimable.length === excess) break;
        }
        if (reclaimable.length < excess) throw new AppError('DOC_CAP_REACHED');
        for (const old of reclaimable) {
          await runtime.backend.deleteDocument(old.docId);
          await runtime.registry.remove(old.docId);
        }
        return false;
      });
  }

  /** Holds taken by one ingest request; released when its pipeline run ends, not its stream. */
  interface Holds {
    ids: Set<string>;
    closed: boolean;
  }
  const releaseDocuments = (held: Holds): void => {
    held.closed = true;
    for (const id of held.ids) {
      const left = (holds.get(id) ?? 1) - 1;
      if (left <= 0) holds.delete(id);
      else holds.set(id, left);
    }
    held.ids.clear();
  };

  /** The ingest fetcher: in hosted modes every hop is checked against the ingest host allowlist. */
  const ingestFetcher = (): typeof runtime.fetcher =>
    hosted
      ? async (url, fetchOptions) => {
          const validateUrl = (target: URL): void => {
            checkIngestFetchHost(target, hosts);
            fetchOptions?.validateUrl?.(target);
          };
          validateUrl(new URL(url));
          const result = await runtime.fetcher(url, {
            ...fetchOptions,
            validateUrl,
          });
          validateUrl(new URL(result.finalUrl));
          return result;
        }
      : runtime.fetcher;
  const ingestParseLimits = () => ({
    ...readParseLimits(publicMode),
    ...(publicMode ? { maxPages: limits.maxPages } : {}),
  });

  /** Fetch and parse only, down the same path ingest takes: no model, no embedding, no registry. */
  async function measure(url: string, signal: AbortSignal) {
    // The same concurrency pool as an ingest, so a burst of quotes or refused ingests cannot
    // start more downloads and parses than ingests could.
    const release = await sharedLimits().acquire('ingest', signal);
    let doc;
    try {
      doc = await fetchAndParseDocument(
        url,
        {
          fetcher: ingestFetcher(),
          now: runtime.now,
          parsePdf: runtime.parsePdf ?? defaultParsePdf,
          parseLimits: ingestParseLimits(),
        },
        signal,
        // A quote stores nothing, not even the download.
        { commitCache: false },
      );
    } finally {
      release();
    }
    const facts = billFacts(doc.sections);
    return {
      doc,
      publicFacts: quoteFacts(doc, facts),
      estimates: estimatesFor(facts, tiers(), options.quote),
    };
  }

  app.post('/api/quote', async (c) => {
    if (publicMode && !options.quote?.allowInPublicMode)
      throw new AppError('PUBLIC_MODE_FORBIDDEN');
    const body = await parseBody(
      c,
      QuoteRequest.extend({ turnstileToken: z.string().optional() }),
      'Enter a full web address, starting with http:// or https://.',
    );
    if (!/^https?:$/.test(new URL(body.url).protocol))
      throw invalid(
        'Enter a full web address, starting with http:// or https://.',
      );
    if (hosted) checkIngestHost(body.url, hosts);
    if (publicMode) await guardPublic(c, quoteLimiter, body.turnstileToken);
    else if (hosted && !quoteLimiter.take(clientIp(c)))
      throw new AppError('RATE_LIMITED');
    if (hosted && !publicMode && !readerQuotes.take(readerFor(c)))
      throw new AppError('RATE_LIMITED');
    const measured = await measure(body.url, c.req.raw.signal);
    const { quoteId } = quotes.add({
      url: body.url,
      contentHash: measured.doc.docId,
      facts: measured.publicFacts,
      estimates: measured.estimates,
      readerId: readerFor(c),
    });
    return c.json({
      quoteId,
      facts: measured.publicFacts,
      estimates: measured.estimates,
    });
  });

  /** Whether the document already has its summary and a finished breakdown on this tier. */
  async function generationComplete(
    c: Context,
    docId: string,
    models: ModelChoice | undefined,
  ): Promise<boolean> {
    try {
      return await runInJob(
        makeScope(c, { kind: 'ingest', docId }, { models }),
        async () => {
          const look = { wait: false, start: false } as const;
          const [s, b, ps, pb, ex] = await Promise.all([
            summary.get(docId, look),
            breakdown.get(docId, look),
            pictures.get(docId, 'summary', look),
            pictures.get(docId, 'breakdown', look),
            breakdown.examplesComplete?.(docId) ?? true,
          ]);
          // Pictures are finished when drawn, or when there was nothing to draw.
          const drawn = (r: { status: string }): boolean =>
            r.status === 'cached' || r.status === 'none';
          return (
            s.status === 'cached' &&
            b.status === 'cached' &&
            b.stoppedReason === undefined &&
            drawn(ps) &&
            drawn(pb) &&
            ex
          );
        },
      );
    } catch {
      return false;
    }
  }

  /**
   * Admission for an ingest, new or reused. Needs the bill's size, so it fetches and parses
   * first (or reuses the quote this server issued to the reader); no model has been called yet.
   * The measured document is handed to the ingest so it is parsed once, and the ingest refuses
   * if the bytes it fetches turn out to be a different document.
   */
  async function admitIngest(
    c: Context,
    body: { url: string; quoteId?: string | undefined },
  ): Promise<
    | { scope: JobScope; admitted?: { docId: string; doc?: NormalizedDoc } }
    | undefined
  > {
    if (!hooked) return undefined;
    if (!estimating) return { scope: makeScope(c, { kind: 'ingest' }, {}) };
    const live = quotes.get(body.quoteId, readerFor(c), body.url);
    let admitted: { docId: string; doc?: NormalizedDoc };
    let estimates: Record<string, BillEstimate>;
    if (live) {
      admitted = { docId: live.contentHash };
      estimates = live.estimates;
    } else {
      const measured = await measure(body.url, c.req.raw.signal);
      admitted = { docId: measured.doc.docId, doc: measured.doc };
      estimates = measured.estimates;
    }
    const fields = {
      kind: 'ingest' as const,
      docId: admitted.docId,
      // The host's own quote id is passed as sent; a matching quote of ours rides alongside.
      ...(body.quoteId ? { quoteId: body.quoteId } : {}),
      ...(live
        ? {
            serverQuote: {
              contentHash: live.contentHash,
              facts: live.facts,
              estimates: live.estimates,
            },
          }
        : {}),
      estimate: firstOf(estimates),
      estimates,
    };
    const models = options.modelFor
      ? checkedChoice(options.modelFor(fields, c))
      : undefined;
    const docComplete = await generationComplete(c, admitted.docId, models);
    const { budget } = await consult(c, {
      ...fields,
      tier: tierName(models),
      ...(docComplete ? { docComplete } : {}),
    });
    return {
      scope: makeScope(
        c,
        { kind: 'ingest', docId: admitted.docId },
        { budget, models },
      ),
      admitted,
    };
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
    if (hosted && !publicMode && !readerIngests.take(readerFor(c)))
      throw new AppError('RATE_LIMITED');
    const admission = await admitIngest(c, body);
    const scope = admission?.scope;

    // Resource policy reaches both the default parser and runtime-injected parsers.
    const parsePdf = runtime.parsePdf ?? defaultParsePdf;
    const held: Holds = { ids: new Set<string>(), closed: false };
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
      (emit, signal) =>
        runInJob(scope, async () => {
          try {
            // The holds last as long as the pipeline run, which can outlive a closed stream
            // (it may still be waiting on a lock). The reader's list is written first, so a
            // finished document is never both unlisted and unprotected.
            const result = await ingest(
              body.url,
              {
                backend: runtime.backend,
                provider: runtime.extractProvider,
                registry: runtime.registry,
                fetcher: ingestFetcher(),
                now: runtime.now,
                // Public servers never evict: a visitor must not push out someone else's document.
                maxDocs: publicMode ? limits.maxDocs : runtime.maxDocs,
                pinned: options.pinned,
                ...(readers
                  ? {
                      evictionGuard: {
                        listed: () => readers.listedDocIds(),
                        inFlight: () => new Set(holds.keys()),
                        neverEvictListed: publicMode,
                      },
                      admit: admitDocuments(held, signal),
                    }
                  : {}),
                parseLimits: ingestParseLimits(),
                parsePdf,
                admitted: admission?.admitted,
                onReferenceSkip: log.referenceSkipped,
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
            )
              .then(async (done) => {
                if (scope) {
                  // The first admitted ingest of a document owns its background generation.
                  scope.context.docId = done.doc.docId;
                  const tier = tierName(scope.models);
                  const key = scopeKey(done.doc.docId, tier);
                  const live = docScopes.get(key);
                  if (live) {
                    // A new admission pays for the document again: if the old budget is spent,
                    // the new one takes its place (and its job id), and stopped work goes on.
                    if (!budgetRemaining(live)) {
                      topUp(live, scope);
                      resumeDoc(done.doc.docId);
                    }
                  } else {
                    // After a restart the host may already hold this tier's scope (and what is
                    // left of its budget); that wins over the scope of the ingest that came first.
                    const saved = await lookupSaved(
                      done.doc.docId,
                      tier,
                      scope.models,
                    ).catch(() => undefined);
                    if (!docScopes.has(key)) {
                      const restored = saved
                        ? scopeFromSaved(c, done.doc.docId, saved, scope.models)
                        : scope;
                      installScope(key, restored);
                      // The host's saved scope may be spent; this admission just paid.
                      if (restored !== scope && !budgetRemaining(restored)) {
                        topUp(restored, scope);
                        resumeDoc(done.doc.docId);
                      }
                    }
                  }
                }
                if (!signal.aborted) await rememberForReader(c, done.doc.docId);
                return done;
              })
              .finally(() => {
                releaseDocuments(held);
              });
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
        }),
      (error) => ({ type: 'error', error }),
      () => {
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
    const scope = await admitJob(
      c,
      {
        kind: 'question',
        docId: entry.docId,
        chipId: body.chipId,
        quoteId: body.quoteId,
      },
      // A metadata chip reads the stored document and never calls a model.
      {
        exempt:
          body.chipId !== undefined &&
          getChip(body.chipId).strategy === 'metadata',
      },
    );

    return sse<AskEvent>(
      c,
      (emit, signal) =>
        runInJob(scope, async () => {
          const result = await ask(
            entry.docId,
            body.chipId === undefined
              ? { question: body.question ?? '' }
              : { chipId: body.chipId },
            {
              backend: runtime.backend,
              // Chips that may not need the model (sponsors) or may do without it (delegations)
              // read the key lazily. Every other request fails on a missing key before retrieval.
              provider:
                body.chipId !== undefined &&
                LAZY_STRATEGIES.has(getChip(body.chipId).strategy)
                  ? lazyProvider(() => runtime.answerProvider)
                  : runtime.answerProvider,
              registry: runtime.registry,
              retrievalMode: runtime.retrievalMode,
              chips: runtime.chips,
              // A public visitor's question costs one model call, not two: no rewrite there.
              readingLevel: publicMode ? undefined : {},
              log: (e) => {
                log.answerEvent(c, e, 0);
              },
              // Public servers make no extra model call for a visitor's story.
              scenario: { enabled: !publicMode },
              publicMode,
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
        }),
      (error) => ({ type: 'error', error }),
    );
  });

  registerScenarioRoute(app, runtime, {
    publicMode,
    now,
    admit: hooked
      ? (c, docId) => admitJob(c, { kind: 'scenario', docId })
      : undefined,
  });
  registerLocateRoute(app, runtime, {
    publicMode,
    rateLimit: (c) => questions.take(clientIp(c)),
    admit: hooked
      ? (c, docId) => admitJob(c, { kind: 'locate', docId })
      : undefined,
    validateUrl: hosted
      ? (url) => {
          checkIngestFetchHost(url, hosts);
        }
      : undefined,
  });

  const breakdown = registerBreakdownRoutes(app, runtime, {
    log: (e) => {
      log.backgroundBreakdownEvent(e);
    },
    publicMode,
    now,
    summary,
    waitMs: options.summaryWaitMs,
    breakdownMaxUnits: options.breakdownMaxUnits,
    pregenerateExamples: options.pregenerateExamples,
    admitExample: hooked
      ? (c, docId) => admitJob(c, { kind: 'example', docId })
      : undefined,
    onError: (c, error, ms) => {
      log.error(c, error, ms);
    },
  });
  const pictures = registerPictureRoutes(app, runtime, {
    publicMode,
    now,
    summary,
    breakdown,
    waitMs: options.summaryWaitMs,
    onError: (c, error, ms) => {
      log.error(c, error, ms);
    },
    log: (e) => {
      log.pictureEvent(e);
    },
  });

  app.all('/api/*', (c) =>
    c.json(
      { error: { code: 'DOC_NOT_FOUND', message: 'No such endpoint.' } },
      404,
    ),
  );

  if (options.webRoot)
    app.use('*', staticAssets(options.webRoot, options.head));

  return app;
}

/** The first entry of a record that is known to be nonempty. */
function firstOf<T>(record: Record<string, T>): T {
  for (const value of Object.values(record)) return value;
  throw new Error('Expected at least one entry.');
}

/** Maps iterate in insertion order, so this drops the entry added longest ago. */
function evictOldest<K>(map: Map<K, unknown>): void {
  for (const key of map.keys()) {
    map.delete(key);
    return;
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
