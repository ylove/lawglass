/**
 * Browser-facing security headers for every response: a strict Content-Security-Policy, plus the
 * usual hardening set. The built UI needs nothing looser than 'self': it uses external module
 * scripts and stylesheets, self-hosted fonts, and applies its one dynamic style through the CSSOM
 * (which CSP allows), so there is no 'unsafe-inline' and no nonce plumbing.
 */
import type { MiddlewareHandler } from 'hono';

/** Where Turnstile's widget script and challenge iframe load from (public mode only). */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export interface SecurityHeadersOptions {
  /** Public servers also allow Cloudflare Turnstile's script and iframe. */
  publicMode: boolean;
  privateMode?: boolean;
}

export function contentSecurityPolicy(publicMode: boolean): string {
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
  const csp = contentSecurityPolicy(options.publicMode);
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', csp);
    if (options.privateMode)
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
