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
// IPv6 is an allowlist: only global unicast (2000::/3) is a fetch target, and the IANA
// special-purpose ranges that sit inside it are carved back out. A blocklist alone kept missing
// newly registered ranges (3fff::/20 documentation, ORCHID, benchmarking); with the allowlist
// anything outside 2000::/3 (::1, fc00::/7, fe80::/10, ff00::/8, 100::/64, 5f00::/16 SRv6 SIDs,
// unassigned space) is refused without being named.
const IPV6_GLOBAL_UNICAST = ipaddr.IPv6.parseCIDR('2000::/3');
const IPV6_SPECIAL_PURPOSE = [
  // IETF protocol assignments, whole /23: Teredo 2001::/32 (XOR-obfuscated client IPv4), PCP and
  // TURN anycast 2001:1::/32, benchmarking 2001:2::/48, AMT 2001:3::/32, AS112 2001:4:112::/48,
  // ORCHID 2001:10::/28, ORCHIDv2 2001:20::/28 and drone remote ID 2001:30::/28.
  '2001::/23',
  '2001:db8::/32', // documentation
  '2620:4f:8000::/48', // direct delegation AS112
  '3fff::/20', // documentation (RFC 9637)
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));
// Forms that carry an IPv4 address; the embedded address decides, so NAT64 or 6to4 to a public
// IPv4 stays reachable while the same forms pointing at 127.0.0.1 or 169.254.169.254 do not.
const EMBEDDED_IPV4 = [
  '::ffff:0:0/96', // IPv4-mapped
  '::ffff:0:0:0/96', // IPv4-translated (SIIT, RFC 2765): ::ffff:0:a.b.c.d
  '::/96', // deprecated IPv4-compatible
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
  const [globalNetwork, globalBits] = IPV6_GLOBAL_UNICAST;
  if (!address.match(globalNetwork, globalBits)) return true;
  return IPV6_SPECIAL_PURPOSE.some(([network, bits]) =>
    address.match(network, bits),
  );
}
