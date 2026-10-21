import type { ProviderId } from '../model/index.js';

/** The service each provider talks to when no base URL overrides it. Named, never inferred. */
const DEFAULT_ENDPOINTS: Readonly<Record<ProviderId, string>> = {
  anthropic: 'https://api.anthropic.com:443',
  openai: 'https://api.openai.com:443',
  google: 'https://generativelanguage.googleapis.com:443',
  'claude-cli': 'claude-cli:local',
  mock: 'mock:local',
};

/**
 * A canonical, non-secret name for where answers come from: scheme, host and port, and nothing
 * else. It belongs in the answer cache key because the same model name behind a different
 * OpenAI-compatible endpoint (a local server, a proxy, another vendor) gives different answers.
 *
 * Credentials, path, query and fragment are dropped on purpose: they can hold secrets, and the
 * key is hashed into file names. Host case and default ports are normalized so equivalent
 * spellings share one identity.
 */
export function endpointIdentity(
  provider: ProviderId,
  baseUrl?: string,
): string {
  if (provider !== 'openai' || !baseUrl?.trim())
    return DEFAULT_ENDPOINTS[provider];
  const url = new URL(baseUrl.trim());
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname}:${port}`;
}
