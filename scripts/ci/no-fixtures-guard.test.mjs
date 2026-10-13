import { expect, test } from 'vitest';
import { findViolations } from './no-fixtures-guard.mjs';

test('accepts ordinary tracked files and small XML samples', () => {
  expect(
    findViolations([
      { path: 'src/example.ts', size: 10000 },
      { path: 'docs/sample.xml', size: 4095 },
    ]),
  ).toEqual([]);
});

test.each(['xml', 'XML'])(
  'rejects oversized .%s documents outside tests/synth/',
  (extension) => {
    expect(
      findViolations([{ path: `docs/bill.${extension}`, size: 4097 }]),
    ).toEqual([expect.stringContaining('exceeds 4 KB')]);
  },
);

test('allows large synthetic documents only under the exact synthetic directory', () => {
  expect(
    findViolations([
      { path: 'tests/synth/nested/sample.pdf', size: 10000 },
      { path: 'tests/synth/sample.docx', size: 10000 },
      { path: 'tests/synth/sample.xml', size: 10000 },
    ]),
  ).toEqual([]);
  expect(
    findViolations([{ path: 'tests/synthetic/sample.xml', size: 10000 }]),
  ).toHaveLength(1);
});

test.each([
  'fixtures/downloads/bill.xml',
  'fixtures/downloads/nested/notes.txt',
])('rejects any downloaded tracked fixture: %s', (path) => {
  expect(findViolations([{ path, size: 0 }])).toEqual([
    expect.stringContaining('downloaded fixtures'),
  ]);
});

test.each([
  '.env',
  '.env.local',
  '.env.production',
  'nested/.env',
  'nested/.env.test',
  '.envrc',
])('rejects tracked environment file %s', (path) => {
  expect(findViolations([{ path, size: 0 }])).toEqual([
    expect.stringContaining('environment files'),
  ]);
});

test('accepts empty example values, comments, exports and CRLF', () => {
  expect(
    findViolations([
      {
        path: 'nested/.env.example',
        size: 100,
        content:
          '# Instructions\r\nKEY=\r\n URL =  \r\nexport OTHER= # comment\r\nSINGLE=\'\'\r\nDOUBLE="" # comment\r\n',
      },
    ]),
  ).toEqual([]);
});

test.each([
  'KEY=example-value',
  'KEY="example-value"',
  "KEY='example-value'",
  'KEY=" "',
  'export KEY=example-value # comment',
  'KEY="\nexample-value\n"',
  'malformed entry',
])(
  'rejects populated or malformed examples without printing values',
  (content) => {
    const violations = findViolations([
      { path: '.env.example', size: 100, content },
    ]);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).not.toContain('example-value');
    expect(violations[0]).toContain('.env.example:1:');
  },
);

test('fails closed when example contents are not supplied', () => {
  expect(findViolations([{ path: '.env.example', size: 0 }])).toEqual([
    expect.stringContaining('contents are missing'),
  ]);
});

test('reports all violations, including paths with spaces or newlines', () => {
  expect(
    findViolations([
      { path: 'docs/a bill\ncopy.pdf', size: 4097 },
      { path: 'fixtures/downloads/notes.txt', size: 1 },
      { path: '.env', size: 1 },
    ]),
  ).toHaveLength(3);
});

test.each(['.env.sample', 'config/.env.template'])(
  'allows empty env template %s',
  (path) => {
    expect(findViolations([{ path, size: 20, content: 'API_KEY=\n' }])).toEqual(
      [],
    );
  },
);

test('rejects a populated .env.sample', () => {
  expect(
    findViolations([
      { path: '.env.sample', size: 30, content: 'API_KEY=abc\n' },
    ]),
  ).toEqual([expect.stringContaining('.env.sample:1:')]);
});

test.each(['docs/tmp/bill.pdf', 'notes/a.docx', 'b.DOC', 'c.rtf'])(
  'rejects a tracked binary document %s at any size',
  (path) => {
    expect(findViolations([{ path, size: 25 }])).toEqual([
      expect.stringContaining('binary documents must not be tracked'),
    ]);
  },
);

test('allows small XML and synthetic test documents', () => {
  expect(
    findViolations([
      { path: 'config/small.xml', size: 512 },
      { path: 'tests/synth/sample.pdf', size: 90_000 },
    ]),
  ).toEqual([]);
});
