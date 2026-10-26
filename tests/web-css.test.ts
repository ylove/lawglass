// Stylesheet rules a component test cannot see: happy-dom does not apply the real cascade.
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('links inside struck or added drawer text inherit the amendment ink', async () => {
  // `.excerpt a` sets the accent color; the override must be at least as specific, or links on
  // the amber/blue fills drop under 4.5:1 contrast in light mode.
  const css = await readFile('src/web/styles/reading.css', 'utf8');
  expect(css).toMatch(
    /\.excerpt del a,\s*\.excerpt ins a,[^{]*\{\s*color: inherit;/,
  );
});
