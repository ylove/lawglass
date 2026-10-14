import { test as base, expect } from '@playwright/test';
import { createPackedApp, type PackedApp } from '../scripts/packed-app.js';

export const test = base.extend<
  { baseURL: string; localSession: undefined },
  { packedApp: PackedApp; packedUrl: string }
>({
  packedApp: [
    async ({}, use) => {
      const app = await createPackedApp();
      try {
        await use(app);
      } finally {
        await app.dispose();
      }
    },
    { scope: 'worker', timeout: 240_000 },
  ],
  packedUrl: [
    async ({ packedApp }, use) => {
      const server = await packedApp.serve();
      await use(server.url);
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ packedUrl }, use) => {
    await use(new URL(packedUrl).origin);
  },
  localSession: [
    async ({ context, packedUrl }, use) => {
      // APIRequestContext shares cookies with the browser; exchange before any page or API call.
      await context.request.get(packedUrl);
      await use(undefined);
    },
    { auto: true },
  ],
});
export { expect };
