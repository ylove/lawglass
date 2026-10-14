/**
 * Bot-check seam for public mode. The default accepts everything (a stub); a deployment can
 * inject a verifier that calls Cloudflare Turnstile's siteverify endpoint.
 */
export type TurnstileVerifier = (
  token: string | undefined,
  ip: string,
) => Promise<boolean>;

export const noopTurnstile: TurnstileVerifier = () => Promise.resolve(true);
