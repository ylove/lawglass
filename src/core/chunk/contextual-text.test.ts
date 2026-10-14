import { expect, test } from 'vitest';
import { contextualText } from './contextual-text.js';

test('prefixes the text with its breadcrumb', () => {
  expect(
    contextualText({
      breadcrumb: 'Sec. 4 > (b) Eligibility',
      text: 'A household may apply.',
    }),
  ).toBe('Sec. 4 > (b) Eligibility: A household may apply.');
});
