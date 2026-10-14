import { isIP } from 'node:net';
import { isLoopbackAddress } from '../core/fetch/ip.js';
import { AppError } from '../core/model/index.js';

/** Pin localhost to IPv4 so the printed link always reaches the address we bound. */
export function validateBindHost(
  host = '127.0.0.1',
  publicMode = false,
): string {
  const address = host.toLowerCase() === 'localhost' ? '127.0.0.1' : host;
  if (!isIP(address) || address.includes('%'))
    throw new AppError('INVALID_INPUT', 'Invalid bind host.', {
      userMessage: '--host must be an IP literal or localhost.',
    });
  if (!publicMode && !isLoopbackAddress(address))
    throw new AppError('INVALID_INPUT', 'Non-loopback bind without --public.', {
      userMessage:
        'Local mode has no authentication for network users. Use a loopback --host or explicitly opt in with --public.',
    });
  return address;
}

/** Host is an authority, so IPv6 must be bracketed; ports never participate in the policy. */
export function isLoopbackHost(host: string): boolean {
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::\d+)?$/.exec(host);
  if (!match) return false;
  if (match[1] && isIP(match[1]) !== 6) return false;
  const address = match[1] ?? match[2] ?? '';
  return address.toLowerCase() === 'localhost' || isLoopbackAddress(address);
}
