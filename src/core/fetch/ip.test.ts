import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './ip.js';

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
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2001:db9::1',
  '::ffff:8.8.8.8',
  '::8.8.8.8',
  '64:ff9b::8.8.8.8',
  '2002:808:808::',
];
describe('address policy', () => {
  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(publicAddresses)('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});
