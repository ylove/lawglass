import { expect, it } from 'vitest';
import { formatFromExtension, sniffFormat } from './sniff.js';

it.each([
  ['%PDF-1.7', 'text/html', 'bill.xml', 'pdf'],
  [' \ufeff<?xml version="1.0"?><bill/>', 'application/pdf', 'bill.pdf', 'xml'],
  ['<bill><section/></bill>', '', 'bill.pdf', 'xml'],
  ['<resolution/>', 'text/html', 'download', 'xml'],
  ['<amendment-doc/>', 'text/plain', 'download', 'xml'],
  ['<uslm/>', 'text/html', 'download', 'xml'],
  ['<lawDoc/>', 'text/html', 'download', 'xml'],
  ['<akomaNtoso/>', 'text/html', 'download', 'xml'],
  ['<TEI/>', 'text/html', 'download', 'xml'],
  ['<ns:bill/>', 'text/html', 'download', 'xml'],
  ['<p>hi', 'text/html', 'download', 'html'],
  ['<custom>hi', 'text/html', 'download', 'html'],
  ['<p>hi', 'application/xml', 'download', 'xml'],
  ['<p>hi', 'text/plain', 'download', 'text'],
  ['<p>hi', '', 'bill.xml', 'xml'],
  ['<custom>hi', '', 'bill.html', 'html'],
  ['<p>hi', '', 'download', 'html'],
  ['<div>hi', '', 'download', 'html'],
  ['<section>hi', '', 'download', 'html'],
  ['<custom>hi', '', 'download', 'xml'],
  ['<bill-text>hi', 'text/html', 'download', 'html'],
  ['<!-- comment -->\n<bill/>', '', 'download', 'xml'],
  [
    '<!-- comment -->\n<!DOCTYPE html><html/>',
    'application/xml',
    'download',
    'html',
  ],
  ['<!DOCTYPE HTML><html/>', 'application/xml', 'bill.xml', 'html'],
  ['<HTML><body/>', '', 'bill.pdf', 'html'],
  ['', 'application/pdf; charset=binary', 'bill.xml', 'pdf'],
  ['', 'TEXT/HTML; charset=utf-8', 'bill.xml', 'html'],
  ['', 'application/xhtml+xml', 'download', 'html'],
  ['', 'application/akn+xml', 'download', 'xml'],
  ['', 'application/xml', 'download', 'xml'],
  ['', 'text/xml', 'download', 'xml'],
  ['', 'text/plain', 'bill.pdf', 'text'],
  ['', 'application/octet-stream', 'bill.PDF?q=1', 'pdf'],
  ['', '', 'bill.xml', 'xml'],
  ['', '', 'bill.htm', 'html'],
  ['', '', 'bill.html', 'html'],
  ['', '', 'bill.txt', 'text'],
  ['SECTION 1. Café grants\n\tare awarded.', '', 'download', 'text'],
  ['', '', 'download', 'unknown'],
  ['\x00\x01\x02abcdef', '', 'download', 'unknown'],
] as const)('sniffs %j (%s / %s) as %s', (body, type, path, expected) => {
  expect(
    sniffFormat(
      new TextEncoder().encode(body),
      type,
      `https://example.gov/${path}`,
    ),
  ).toBe(expected);
});
it('does not treat invalid UTF-8 as text', () => {
  expect(
    sniffFormat(new Uint8Array([255, 254, 128]), '', 'https://example.gov/'),
  ).toBe('unknown');
});
it('uses only the pathname for extensions', () => {
  expect(
    formatFromExtension('https://example.gov/download?file=bill.pdf'),
  ).toBe('unknown');
});
