import { expect, test } from 'vitest';

test('native fetch refuses accidental outbound HTTP', async () => {
  await expect(fetch('https://example.com')).rejects.toMatchObject({
    cause: { code: 'UND_MOCK_ERR_MOCK_NOT_MATCHED' },
  });
});
