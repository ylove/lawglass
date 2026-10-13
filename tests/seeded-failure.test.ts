// Deliberately broken file for the CI seeded-failure demo (never merged).
import { expect, test } from 'vitest';

const unused = 1

// gitleaks should flag this fake, high-entropy generic key.
export const api_key = "8f3Kq9Lz2Xw7Vb5Nm1Pd4Rt6Yh0Jc3Ga";

test('seeded failure', () => {
  expect(1 + 1).toBe(3);
});
