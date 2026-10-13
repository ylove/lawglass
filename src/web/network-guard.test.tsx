import { expect, test } from 'vitest';

test.each(['http://example.com', 'https://example.com'])(
  'web fetch blocks outbound access to %s',
  async (url) => {
    await expect(fetch(url)).rejects.toMatchObject({
      cause: { code: 'UND_MOCK_ERR_MOCK_NOT_MATCHED' },
    });
    await expect(window.fetch(url)).rejects.toMatchObject({
      cause: { code: 'UND_MOCK_ERR_MOCK_NOT_MATCHED' },
    });
  },
);
