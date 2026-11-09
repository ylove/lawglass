/**
 * Browser-facing security headers for every response: a strict Content-Security-Policy, plus the
 * usual hardening set. The built UI needs nothing looser than 'self': it uses external module
 * scripts and stylesheets, self-hosted fonts, and applies its one dynamic style through the CSSOM
 * (which CSP allows), so there is no 'unsafe-inline' and no nonce plumbing.
 */
import type { MiddlewareHandler } from 'hono';

/** Where Turnstile's widget script and challenge iframe load from (public mode only). */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export type CspExtensions = Partial<
  Record<
    | 'script-src'
    | 'connect-src'
    | 'img-src'
    | 'frame-src'
    | 'style-src'
    | 'font-src'
    | 'form-action',
    string[]
  >
>;

const EXTENSIBLE_DIRECTIVES = new Set([
  'script-src',
  'connect-src',
  'img-src',
  'frame-src',
  'style-src',
  'font-src',
  'form-action',
]);

/**
 * Sources are public https origins, never arbitrary CSP tokens or paths that could add
 * directives. A wildcard must sit under a registrable-looking domain (at least two labels after
 * "*.", so "*.com" is refused), and IP literals and localhost are refused: a hosted page never
 * needs them, and they are the usual sign of a mistyped or overly broad host config.
 */
function validSource(source: string): boolean {
  if (source === "'self'") return true;
  const match =
    /^https:\/\/(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::[0-9]{1,5})?$/i.exec(
      source,
    );
  if (!match) return false;
  const port = /:([0-9]+)$/.exec(source)?.[1];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
    return false;
  const host = (match[2] ?? '').toLowerCase();
  const labels = host.split('.');
  if (match[1] && labels.length < 2) return false;
  if (
    /^[0-9.]+$/.test(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  )
    return false;
  // The last label is a TLD: letters only, so "https://example.123" is not an origin.
  return /^[a-z]{2,}$/.test(labels[labels.length - 1] ?? '');
}

export interface SecurityHeadersOptions {
  /** Public servers also allow Cloudflare Turnstile's script and iframe. */
  publicMode: boolean;
  privateMode?: boolean;
  /** External auth is also hosted behind a TLS terminator. */
  externalAuth?: boolean;
  csp?: CspExtensions;
}

export function contentSecurityPolicy(
  publicMode: boolean,
  extensions: CspExtensions = {},
): string {
  const input: unknown = extensions;
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error(
      'Invalid CSP extensions: use a directive-to-sources object.',
    );
  const directives: [string, string][] = [
    ['default-src', "'self'"],
    ['script-src', publicMode ? `'self' ${TURNSTILE_ORIGIN}` : "'self'"],
    ['style-src', "'self'"],
    ['img-src', "'self' data:"],
    ['font-src', "'self'"],
    ['connect-src', "'self'"],
    ...(publicMode
      ? [['frame-src', TURNSTILE_ORIGIN] as [string, string]]
      : []),
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  for (const [name, sources] of Object.entries(extensions)) {
    if (
      !EXTENSIBLE_DIRECTIVES.has(name) ||
      !Array.isArray(sources) ||
      sources.some(
        (source) => typeof source !== 'string' || !validSource(source),
      )
    )
      throw new Error(
        `Invalid CSP extension for ${name}: use HTTPS origins or 'self'.`,
      );
    if (!sources.length) continue;
    const existing = directives.find(([directive]) => directive === name);
    if (existing) existing[1] += ` ${sources.join(' ')}`;
    // An absent directive inherits default-src 'self'; preserve that fallback when extending it.
    else directives.push([name, `'self' ${sources.join(' ')}`]);
  }
  return directives.map(([name, value]) => `${name} ${value}`).join('; ');
}

/** Deny every powerful browser feature; the app uses none of them. */
export const PERMISSIONS_POLICY = [
  'accelerometer',
  'autoplay',
  'bluetooth',
  'camera',
  'clipboard-read',
  'display-capture',
  'geolocation',
  'gyroscope',
  'hid',
  'interest-cohort',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'serial',
  'usb',
  'xr-spatial-tracking',
]
  .map((feature) => `${feature}=()`)
  .join(', ');

/**
 * Sets the headers after the rest of the chain has run, so they also cover error responses and
 * early returns (401, 403, 413, 415, 404). Private previews run behind a TLS terminator.
 */
export function securityHeaders(
  options: SecurityHeadersOptions,
): MiddlewareHandler {
  const csp = contentSecurityPolicy(options.publicMode, options.csp);
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', csp);
    if (options.privateMode || options.externalAuth)
      c.header('Strict-Transport-Security', 'max-age=31536000');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Permissions-Policy', PERMISSIONS_POLICY);
    // API answers are per-user and may be paid-for generations; SSE sets its own no-cache, which
    // this replaces with the stricter value.
    if (c.req.path === '/api' || c.req.path.startsWith('/api/'))
      c.header('Cache-Control', 'no-store');
  };
}
