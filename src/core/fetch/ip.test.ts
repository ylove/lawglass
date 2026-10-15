import { describe, expect, it } from 'vitest';
import { isBlockedAddress, isLoopbackAddress } from './ip.js';

// Each policy CIDR has a representative plus edge cases for the narrower prefixes.
const blocked = [
  '0.1.2.3',
  '10.0.0.1',
  '100.64.0.0',
  '100.127.255.255',
  '127.0.0.1',
  '169.254.0.1',
  '169.254.169.254',
  '172.16.0.0',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.2.1',
  '192.88.99.0',
  '192.88.99.255',
  '192.168.0.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '100::1',
  '100::ffff:ffff:ffff:ffff',
  '2001:0:4136:e378:8000:63bf:80ff:fffe',
  '2001::808:808',
  'fec0::1',
  'feff::1',
  'fc00::1',
  'fdff::1',
  'fd00:ec2::254',
  'fe80::1',
  'febf::1',
  'ff02::1',
  '2001:db8::1',
  '::ffff:127.0.0.1',
  '::ffff:a00:1',
  '::127.0.0.1',
  '::a9fe:a9fe',
  '64:ff9b::192.168.0.1',
  '64:ff9b:1:7f00:0:100::',
  '64:ff9b:1:c0a8:0:100::',
  '64:ff9b:1::192.168.0.1',
  '2002:7f00:1::',
  '2002:a9fe:a9fe::',
  'bad address',
  '',
  'fe80::1%en0',
  '8.8.8.8%en0',
];
const publicAddresses = [
  '1.1.1.1',
  '8.8.8.8',
  '100.63.255.255',
  '100.128.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '192.0.1.1',
  '192.88.98.255',
  '192.88.100.0',
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2001:db9::1',
  '::ffff:8.8.8.8',
  '::8.8.8.8',
  '64:ff9b::8.8.8.8',
  '64:ff9b:1:808:8:800::',
  '2002:808:808::',
];
// IANA special-purpose IPv6 ranges and their edges. Each row gives the range, an address at its
// first and last position, and one just outside it that must stay reachable (or, for ranges
// carved out of 2000::/3, still be judged by the allowlist). Removing any range fails its row.
const specialPurposeRanges: readonly {
  range: string;
  first: string;
  last: string;
  justAbove: string | undefined;
  justBelow: string | undefined;
}[] = [
  {
    range: '3fff::/20',
    first: '3fff::',
    last: '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff',
    justAbove: '3fff:1000::',
    justBelow: '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  },
  {
    range: '2001:2::/48',
    first: '2001:2::',
    last: '2001:2:0:ffff:ffff:ffff:ffff:ffff',
    justAbove: undefined, // still inside 2001::/23, which is blocked whole
    justBelow: undefined,
  },
  {
    range: '2001:10::/28',
    first: '2001:10::',
    last: '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff',
    justAbove: undefined,
    justBelow: undefined,
  },
  {
    range: '2001:20::/28',
    first: '2001:20::',
    last: '2001:2f:ffff:ffff:ffff:ffff:ffff:ffff',
    justAbove: undefined,
    justBelow: undefined,
  },
  {
    range: '2001::/23',
    first: '2001::',
    last: '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
    justAbove: '2001:200::',
    justBelow: '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  },
  {
    range: '2001:db8::/32',
    first: '2001:db8::',
    last: '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
    justAbove: '2001:db9::',
    justBelow: '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
  },
  {
    range: '2620:4f:8000::/48',
    first: '2620:4f:8000::',
    last: '2620:4f:8000:ffff:ffff:ffff:ffff:ffff',
    justAbove: '2620:4f:8001::',
    justBelow: '2620:4f:7fff:ffff:ffff:ffff:ffff:ffff',
  },
  {
    range: '5f00::/16',
    first: '5f00::',
    last: '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    justAbove: undefined, // outside 2000::/3, so the allowlist refuses the whole neighbourhood
    justBelow: undefined,
  },
];

describe('IPv6 special-purpose ranges', () => {
  describe.each(specialPurposeRanges)('$range', (row) => {
    it('blocks its first and last address', () => {
      expect(isBlockedAddress(row.first)).toBe(true);
      expect(isBlockedAddress(row.last)).toBe(true);
    });
    it('does not spill past its edges', () => {
      if (row.justAbove) expect(isBlockedAddress(row.justAbove)).toBe(false);
      if (row.justBelow) expect(isBlockedAddress(row.justBelow)).toBe(false);
    });
  });

  // ::ffff:0:a.b.c.d (IPv4-translated, ::ffff:0:0:0/96) is unwrapped like IPv4-mapped, so a
  // private target cannot hide in it, and a public one is still allowed.
  it.each([
    '::ffff:0:127.0.0.1',
    '::ffff:0:7f00:1',
    '::ffff:0:10.0.0.1',
    '::ffff:0:a9fe:a9fe',
    '0:0:0:0:ffff:0:c0a8:1',
  ])('blocks the IPv4-translated form %s of a private address', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it('allows the IPv4-translated form of a public address', () => {
    expect(isBlockedAddress('::ffff:0:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('::ffff:0:808:808')).toBe(false);
  });

  // The IPv6 policy is an allowlist: global unicast 2000::/3 only.
  it.each([
    '4000::1',
    '5f00::1',
    '8000::1',
    'a000::1',
    'e000::1',
    '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '100:0:0:1::1',
    '200::1',
  ])('blocks %s because it is outside 2000::/3', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each([
    '2000::1',
    '2a03:2880:f12f:83:face:b00c::25de',
    '3ffe::1',
    '3fff:1000::1',
    '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('allows global unicast %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('address policy', () => {
  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(publicAddresses)('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('loopback addresses', () => {
  it.each([
    '127.0.0.0',
    '127.0.0.1',
    '127.0.0.2',
    '127.255.255.255',
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::ffff:127.0.0.1',
    '::ffff:127.0.0.2',
    '::ffff:127.255.255.255',
    '::FFFF:7f00:1',
    '0:0:0:0:0:ffff:7fff:ffff',
  ])('recognizes %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });
  it.each([
    '',
    'localhost',
    '[::1]',
    'bad address',
    '127.1',
    '2130706433',
    '127.0.0.1:80',
    '127.0.0.1%en0',
    '::1%lo0',
    '126.255.255.255',
    '128.0.0.0',
    '0.0.0.0',
    '::',
    '::2',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    'fc00::1',
    'fe80::1',
    '8.8.8.8',
    '2001:db8::1',
    '::ffff:128.0.0.1',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    '64:ff9b::127.0.0.1',
    '2002:7f00:1::',
  ])('rejects %s', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});
