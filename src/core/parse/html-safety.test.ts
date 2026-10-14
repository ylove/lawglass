import { expect, it } from 'vitest';
import {
  assertHtmlBytes,
  assertHtmlDepth,
  MAX_HTML_DEPTH,
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
  assertHtmlDepth(
    '<div>'.repeat(MAX_HTML_DEPTH) + '</div>'.repeat(MAX_HTML_DEPTH),
  );
  expect(() => {
    assertHtmlDepth('<div>'.repeat(MAX_HTML_DEPTH + 1));
  }).toThrow(/nesting depth/);
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
