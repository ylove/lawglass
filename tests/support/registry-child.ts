// Child process for the registry cross-process lock test: adds one document, then exits.
import { Registry } from '../../src/core/registry.js';
import { EMPTY_METADATA } from '../../src/core/model/index.js';

const [dir, char, count] = process.argv.slice(2);
if (!dir || !char)
  throw new Error('usage: registry-child <dir> <char> <count>');
const registry = new Registry(dir);
for (let i = 0; i < Number(count ?? 1); i += 1) {
  const docId = `${char}${i.toString(16).padStart(2, '0')}`.padEnd(64, char);
  await registry.add(
    {
      docId,
      sourceUrl: 'https://example.com/bill',
      format: 'html',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      metadata: { ...EMPTY_METADATA },
      sections: [],
      definitions: [],
      externalRefs: [],
      warnings: [],
    },
    { label: `${char}-${String(i)}`, backend: 'local' },
  );
}
