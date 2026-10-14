import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeWithFixture,
  fixturePath,
} from '../../tests/support/fixtures.js';
import { readManifest } from '../../scripts/fixture-manifest.js';
import {
  groupLines,
  markConflict,
  MarkLabel,
  MarkLabelFile,
  tokensHash,
} from './marks-labels.js';

const labelsPath = new URL(
  './golden/marks/oh-columbus-issue8-2026.json',
  import.meta.url,
);
const labels = MarkLabelFile.parse(
  JSON.parse(readFileSync(labelsPath, 'utf8')),
);

describe('mark labels', () => {
  it('parse and reference distinct tokens per status', () => {
    expect(labels.lines.length).toBeGreaterThan(0);
    const struck = labels.lines
      .flatMap((line) => line.marks)
      .filter((mark) => mark.status === 'struck');
    expect(struck.length).toBe(9);
  });

  it('pins the label sha256 to the manifest entry for the fixture', () => {
    const entry = readManifest().fixtures.find(
      (fixture) => fixture.name === labels.fixture,
    );
    expect(entry?.sha256).toBe(labels.sha256);
  });

  it('rejects empty or reversed character ranges', () => {
    const base = { token: 0, status: 'struck', evidence: 'none' };
    expect(MarkLabel.safeParse({ ...base, chars: [0, 3] }).success).toBe(true);
    expect(MarkLabel.safeParse({ ...base, chars: [9, 1] }).success).toBe(false);
    expect(MarkLabel.safeParse({ ...base, chars: [2, 2] }).success).toBe(false);
  });

  it('rejects conflicting or overlapping marks on one token', () => {
    const mark = (token: number, chars?: [number, number]): MarkLabel => ({
      token,
      status: 'struck',
      evidence: 'none',
      ...(chars ? { chars } : {}),
    });
    expect(markConflict([mark(0, [0, 3]), mark(0, [3, 6])], 2)).toBeUndefined();
    expect(markConflict([mark(0), mark(0, [0, 2])], 2)).toMatch(/without/);
    expect(markConflict([mark(0, [0, 4]), mark(0, [3, 6])], 2)).toMatch(
      /overlapping/,
    );
    expect(markConflict([mark(5)], 2)).toMatch(/outside/);
    const file = {
      ...labels,
      lines: [
        {
          ...labels.lines[0]!,
          marks: [mark(0), mark(0, [0, 2])],
        },
      ],
    };
    expect(MarkLabelFile.safeParse(file).success).toBe(false);
  });

  it('groups items into lines by baseline and orders them by x', () => {
    const lines = groupLines([
      { str: 'second', x: 50, y: 700.4 },
      { str: 'first', x: 10, y: 701 },
      { str: ' ', x: 40, y: 701 },
      { str: 'next line', x: 10, y: 680 },
    ]);
    expect(lines).toEqual([
      { y: 700.4, tokens: ['first', 'second'] },
      { y: 680, tokens: ['next', 'line'] },
    ]);
    expect(tokensHash(['a', 'b'])).toMatch(/^[a-f0-9]{16}$/);
  });
});

describeWithFixture(labels.fixture, () => {
  it('match the real PDF line by line (labels have not drifted)', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const path = fixturePath(labels.fixture);
    if (!path) throw new Error('fixture vanished');
    const bytes = readFileSync(path);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      labels.sha256,
    );
    const pdf = await getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
    }).promise;
    const page = await pdf.getPage(labels.page);
    const content = await page.getTextContent();
    const lines = groupLines(
      content.items.flatMap((item) =>
        'str' in item
          ? [
              {
                str: item.str,
                x: item.transform[4] as number,
                y: item.transform[5] as number,
              },
            ]
          : [],
      ),
    );
    for (const label of labels.lines) {
      const line = lines.find(
        (candidate) => Math.abs(candidate.y - label.y) < 0.05,
      );
      expect(line, `line at y=${String(label.y)}`).toBeDefined();
      expect(line?.tokens.length).toBe(label.tokenCount);
      expect(tokensHash(line?.tokens ?? [])).toBe(label.lineHash);
      for (const mark of label.marks) {
        expect(mark.token).toBeLessThan(label.tokenCount);
        if (mark.chars) {
          const token = line?.tokens[mark.token] ?? '';
          expect(mark.chars[1]).toBeLessThanOrEqual(token.length);
        }
      }
    }
  });
});
