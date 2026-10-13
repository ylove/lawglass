import ipaddr from 'ipaddr.js';

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
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));
const EMBEDDED_IPV4 = [
  '::ffff:0:0/96',
  '::/96',
  '64:ff9b::/96',
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
    const embedded =
      embedding[1] === 16 ? octets.slice(2, 6) : octets.slice(12);
    return isBlockedAddress(embedded.join('.'));
  }
  return false;
}
