import { expect, it } from 'vitest';
import { load } from 'cheerio';
import { AppError } from '../model/index.js';
import {
  assertHtmlBytes,
  assertHtmlDepth,
  MAX_HTML_DEPTH,
  withHtmlDepthLimit,
} from './html-safety.js';

it('refuses 20k nested divs in under 200 ms before DOM construction', () => {
  const html = '<div>'.repeat(20_000) + 'Bill text' + '</div>'.repeat(20_000);
  const start = performance.now();
  expect(() => {
    assertHtmlDepth(html);
  }).toThrow(/nesting depth/);
  expect(performance.now() - start).toBeLessThan(200);
});

it('accepts exactly the depth cap and refuses the next level', () => {
  // Reserve implicit html/body elements and a possible text/comment leaf.
  assertHtmlDepth(
    '<div>'.repeat(MAX_HTML_DEPTH - 3) + '</div>'.repeat(MAX_HTML_DEPTH - 3),
  );
  expect(() => {
    assertHtmlDepth('<div>'.repeat(MAX_HTML_DEPTH - 2));
  }).toThrow(/nesting depth/);
});

it('maps stack exhaustion to the same depth error and preserves other failures', () => {
  const overflow = new RangeError('Maximum call stack size exceeded');
  expect(() =>
    withHtmlDepthLimit(() => {
      throw overflow;
    }),
  ).toThrow(
    expect.objectContaining({
      code: 'TOO_LARGE',
      message: 'HTML nesting depth limit exceeded.',
      cause: overflow,
    }) as AppError,
  );
  const failure = new Error('DOM failure');
  expect(() =>
    withHtmlDepthLimit(() => {
      throw failure;
    }),
  ).toThrow(failure);
});

it('conservatively bounds parse5 tree depth on 600 seeded malformed documents', () => {
  let seed = 0x182223;
  const random = (limit: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const tags = [
    'div',
    'p',
    'span',
    'b',
    'i',
    'table',
    'td',
    'tr',
    'col',
    'template',
    'svg',
    'g',
    'foreignObject',
    'math',
    'mtext',
    'script',
    'style',
    'textarea',
    'title',
    'select',
    'option',
    'plaintext',
    'br',
    'img',
    'custom',
    'script!',
  ];
  const attrs = [
    '',
    ' a=x"',
    " a=x'",
    ' "a',
    ' a = ">"',
    " a= '<div>'",
    ' a=x=y"',
    ' ="',
    ' a\u00a0="',
    ' a=x/',
    ' /',
    '/',
  ];
  const noise = [
    'text',
    '<!-- <div> -->',
    '<!-->',
    '<!--->',
    '<!-- x --!>',
    '<!bogus </div>>',
    '<?ignored </p>>',
    '</?>',
    '<3>',
    '"\'>',
    '<![CDATA[<div>]]>',
  ];

  for (let sample = 0; sample < 600; sample++) {
    let html = '';
    const open: string[] = [];
    for (let token = 0, count = 10 + random(70); token < count; token++) {
      const tag = tags[random(tags.length)]!;
      const kind = random(5);
      if (kind < 2) {
        html += `<${tag}${attrs[random(attrs.length)]!}>`;
        open.push(tag);
      } else if (kind === 2) html += `</${open.pop() ?? tag}>`;
      else if (kind === 3) html += `</${tag}>`;
      else html += noise[random(noise.length)]!;
    }
    html += open
      .reverse()
      .map((tag) => `</${tag}>`)
      .join('');

    // Cheerio's default loader uses parse5. Include template document fragments in
    // the actual depth; inspect the tree iteratively so the oracle has no recursion.
    const root = load(html).root()[0]!;
    const pending: {
      node: typeof root | (typeof root)['children'][number];
      depth: number;
    }[] = [{ node: root, depth: 0 }];
    let actual = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      actual = Math.max(actual, depth);
      if ('children' in node)
        for (const child of node.children) {
          pending.push({ node: child, depth: depth + 1 });
        }
    }
    expect(
      assertHtmlDepth(html),
      `sample ${String(sample)}: ${html}`,
    ).toBeGreaterThanOrEqual(actual);
  }
});

it('handles voids, quoted attributes, comments, raw text and foreign self-closing elements', () => {
  assertHtmlDepth(
    '<DIV title=">"><!-- <div> --><br><img/><input><script>"<div>"</script><style>/* <div> */</style><textarea><div></textarea><svg>' +
      '<path/>'.repeat(1_000) +
      '</svg></DIV>',
  );
  assertHtmlDepth('<p>one</p>'.repeat(1_000));
  assertHtmlDepth('<plaintext>' + '<div>'.repeat(1_000));
  assertHtmlDepth('<div title="\'">x</div><div title=\'"\'>y</div>');
  assertHtmlDepth('<!doctype html><?ignored?><3>');
  assertHtmlDepth('<!-- unterminated <div>');
  assertHtmlDepth('<!--!><div> -->');
  assertHtmlDepth('<!-->x<!--->y<!-- x --!><div/>');
});

it('does not let mismatched closing tags or ignored HTML self-closing slashes hide depth', () => {
  expect(() => {
    assertHtmlDepth('<div/></p>'.repeat(MAX_HTML_DEPTH + 1));
  }).toThrow(/nesting depth/);
  expect(() => {
    assertHtmlDepth('<svg><foreignObject>' + '<div/>'.repeat(MAX_HTML_DEPTH));
  }).toThrow(/nesting depth/);
});

it('enforces bytes and handles non-tags and unterminated attributes', () => {
  assertHtmlBytes(10, 10);
  expect(() => {
    assertHtmlBytes(11, 10);
  }).toThrow(/byte limit/);
  assertHtmlDepth('plain text < 5 and > 2');
  assertHtmlDepth('<div attr="unterminated');
});

it('accounts for HTML breakouts from SVG, including void tags', () => {
  expect(() => {
    assertHtmlDepth('<svg>' + '<div/>'.repeat(MAX_HTML_DEPTH));
  }).toThrow(/nesting depth/);
  expect(() => {
    assertHtmlDepth('<svg><br>' + '<custom/>'.repeat(MAX_HTML_DEPTH));
  }).toThrow(/nesting depth/);
});
