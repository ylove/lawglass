/**
 * Text sanitizing shared by the history adapters. Everything here is linear in the input
 * length: no backtracking regexes over untrusted text, and callers cap length first.
 *
 * Output is plain text. Bare `<` and `>` are dropped, so markup can never survive, and
 * consumers must still render it as text, never as HTML.
 */

// Zero-width (U+200B-200F), bidi embedding/override (U+202A-202E), bidi isolate
// (U+2066-2069) and the byte order mark (U+FEFF). They can spoof or hide text in a UI.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export const MAX_TEXT = 2_000;
export const MAX_NAME = 200;

/** Remove zero-width and bidi control characters. */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, '');
}

/** One pass: `<...>` becomes a space. An unterminated tag drops the rest; a bare `>` is dropped. */
function stripTags(value: string): string {
  let out = '';
  let inTag = false;
  for (const char of value) {
    if (inTag) {
      if (char === '>') inTag = false;
    } else if (char === '<') {
      inTag = true;
      out += ' ';
    } else if (char !== '>') out += char;
  }
  return out;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeEntities(value: string): string {
  return value.replace(
    /&(#[0-9]{1,6}|#x[0-9a-f]{1,5}|[a-z]{2,6});/gi,
    (m, e) => {
      const name = String(e);
      if (name.startsWith('#')) {
        const hex = name[1] === 'x' || name[1] === 'X';
        const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? m;
    },
  );
}

/**
 * Strip markup, entities, control and invisible characters, collapse whitespace and cap
 * the length (with an ellipsis). Entities are decoded between two tag passes so an
 * encoded tag cannot survive.
 */
export function sanitizeText(value: string, max: number = MAX_TEXT): string {
  // Bound the work before any pass; a 1 MB field costs the same as a 40 KB one.
  const bounded = value.slice(0, max * 20);
  const stripped = stripTags(decodeEntities(stripTags(stripInvisible(bounded))))
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > max
    ? `${stripped.slice(0, max).trimEnd()}…`
    : stripped;
}
