import { expect, test } from 'vitest';
import { BILLSTATUS_XML, makeBillStatusXml } from './index.js';

test('BILLSTATUS sample returns fresh deterministic bytes with no file or network access', () => {
  const first = makeBillStatusXml();
  const second = makeBillStatusXml();
  expect(new TextDecoder().decode(first)).toBe(BILLSTATUS_XML);
  expect(first).toEqual(second);
  expect(first.buffer).not.toBe(second.buffer);
  first.fill(0);
  expect(makeBillStatusXml()).toEqual(second);
});
