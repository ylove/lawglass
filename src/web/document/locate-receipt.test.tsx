import { afterEach, expect, it, vi } from 'vitest';
import { BRAND } from '../../core/brand.js';
import type { DocDetail, LocateMatch } from '../../core/model/index.js';
import { createMockApi } from '../mock-api.js';
import { buildReceipt, copyReceipt } from './locate-receipt.js';

async function fixture(): Promise<{ detail: DocDetail; match: LocateMatch }> {
  const api = createMockApi({ delayMs: 0 });
  const doc = (await api.listDocs())[0]!;
  const detail = await api.getDoc(doc.docId);
  const match = (await api.locate(doc.docId, { text: 'fifteen years' }))
    .matches[0]!;
  detail.metadata.version = 'Introduced in House';
  return { detail, match };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('builds the exact receipt with removal status, printed location, version, date, and official URL', async () => {
  const { detail, match } = await fixture();
  expect(buildReceipt(match, detail).plain).toBe(
    `"[removed: within fifteen years]" — HB 214, Clean Water Infrastructure Act > Section 4 > (b), page 3, lines 5–12, Introduced in House (2026-02-03). The bill removes the fifteen-year deadline. Source: https://example.gov/bills/hb214.pdf. Found with ${BRAND.displayName}; not legal advice.`,
  );
  expect(buildReceipt(match, detail).markdown).toContain(
    '\\[removed: within fifteen years\\]',
  );
  expect(buildReceipt(match, detail).markdown).toContain(
    '[Official source](<https://example.gov/bills/hb214.pdf>)',
  );
});
it('keeps conditions and the named changed law in the receipt; handles missing metadata', async () => {
  const { detail, match } = await fixture();
  match.conditions = 'Only for eligible towns [S:sec-4/b].';
  match.amends = '42 U.S.C. 1395';
  match.location = {};
  detail.metadata.version = null;
  delete detail.history;
  detail.doc.billNumber = null;
  detail.doc.title = null;
  const receipt = buildReceipt(match, detail).plain;
  expect(receipt).toContain('Version not stated.');
  expect(receipt).toContain(
    'Conditions: Only for eligible towns. Changes 42 U.S.C. 1395.',
  );
  expect(receipt).not.toContain('[S:');
});
it('writes both clipboard types when supported', async () => {
  const write = vi.fn<(items: ClipboardItem[]) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { write, writeText } });
  class Item {
    constructor(readonly data: Record<string, Blob>) {}
  }
  vi.stubGlobal('ClipboardItem', Item);
  await copyReceipt({ plain: 'plain receipt', markdown: '**receipt**' });
  const item = write.mock.calls[0]?.[0] as unknown as Item[];
  expect(item[0]!.data['text/plain']!.type).toBe('text/plain');
  expect(item[0]!.data['text/markdown']!.type).toBe('text/markdown');
  expect(writeText).not.toHaveBeenCalled();
});
it('falls back to plain text for missing or rejected Markdown support', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', {
    clipboard: {
      write: () => Promise.reject(new Error('unsupported')),
      writeText,
    },
  });
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly data: unknown) {}
    },
  );
  await copyReceipt({ plain: 'receipt', markdown: 'receipt' });
  expect(writeText).toHaveBeenCalledWith('receipt');
  vi.stubGlobal('ClipboardItem', undefined);
  await copyReceipt({ plain: 'receipt 2', markdown: 'receipt 2' });
  expect(writeText).toHaveBeenLastCalledWith('receipt 2');
});
