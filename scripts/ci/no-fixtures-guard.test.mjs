import { expect, test } from 'vitest';
import { findViolations } from './no-fixtures-guard.mjs';

test('accepts ordinary tracked files and small document samples', () => {
  expect(
    findViolations([
      { path: 'src/example.ts', size: 10000 },
      { path: 'docs/sample.pdf', size: 4096 },
      { path: 'docs/sample.docx', size: 0 },
      { path: 'docs/sample.xml', size: 4095 },
    ]),
  ).toEqual([]);
});

test.each(['pdf', 'docx', 'xml', 'PDF', 'DOCX', 'XML'])(
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
