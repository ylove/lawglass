import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';

/** Loopback only, unlike the broader SSRF policy below. Mapped IPv6 uses its IPv4 range. */
export function isLoopbackAddress(ip: string): boolean {
  if (ip.includes('%') || !isIP(ip)) return false;
  if (isIP(ip) === 6 && ip.includes('.')) {
    // ipaddr.js treats the obsolete ::a.b.c.d notation as mapped IPv4. Convert the dotted
    // suffix to hex first so only the actual ::ffff:0:0/96 network counts as mapped.
    const split = ip.lastIndexOf(':') + 1;
    const suffix = ipaddr.IPv4.parse(ip.slice(split))
      .toIPv4MappedAddress()
      .parts.slice(-2)
      .map((part) => part.toString(16))
      .join(':');
    ip = ip.slice(0, split) + suffix;
  }
  return ipaddr.process(ip).range() === 'loopback';
}

// Keep the policy explicit: special-use and documentation networks are not fetch targets.
const IPV4_BLOCKS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));
const IPV6_BLOCKS = [
  '::/128',
  '::1/128',
  '100::/64',
  // Block Teredo outright, including its XOR-obfuscated client IPv4.
  '2001::/32',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
  '2001:db8::/32',
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));
const EMBEDDED_IPV4 = [
  '::ffff:0:0/96',
  '::/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '2002::/16',
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

export function isBlockedAddress(ip: string): boolean {
  // Invalid resolver output and scoped interfaces fail closed.
  if (ip.includes('%') || !ipaddr.isValid(ip)) return true;
  const address = ipaddr.parse(ip);
  if (address instanceof ipaddr.IPv4) {
    return IPV4_BLOCKS.some(([network, bits]) => address.match(network, bits));
  }
  if (IPV6_BLOCKS.some(([network, bits]) => address.match(network, bits)))
    return true;
  const embedding = EMBEDDED_IPV4.find(([network, bits]) =>
    address.match(network, bits),
  );
  if (embedding) {
    const octets = address.toByteArray();
    // RFC 6052's /48 layout splits IPv4 around the reserved byte at offset 8.
    const embedded =
      embedding[1] === 16
        ? octets.slice(2, 6)
        : embedding[1] === 48
          ? [...octets.slice(6, 8), ...octets.slice(9, 11)]
          : octets.slice(12);
    return isBlockedAddress(embedded.join('.'));
  }
  return false;
}
