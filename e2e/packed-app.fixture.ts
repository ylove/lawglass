import { test as base, expect } from '@playwright/test';
import { createPackedApp, type PackedApp } from '../scripts/packed-app.js';

export const test = base.extend<
  { baseURL: string; localSession: undefined; cspGuard: undefined },
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
  // Fails any test during which the browser reports a Content-Security-Policy violation.
  cspGuard: [
    async ({ page }, use) => {
      const violations: string[] = [];
      page.on('console', (message) => {
        if (/content security policy/i.test(message.text()))
          violations.push(`console: ${message.text()}`);
      });
      page.on('pageerror', (error) => {
        if (/content security policy/i.test(error.message))
          violations.push(`pageerror: ${error.message}`);
      });
      await page.addInitScript({
        content: `window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  window.__cspViolations.push(event.violatedDirective + ' blocked ' + event.blockedURI);
});`,
      });
      await use(undefined);
      for (const p of page.context().pages()) {
        if (p.isClosed()) continue;
        const recorded = await p
          // A function, not a string: Playwright evaluates strings with eval(), which CSP would flag.
          .evaluate(
            () =>
              (globalThis as unknown as { __cspViolations?: string[] })
                .__cspViolations ?? [],
          )
          .catch((): string[] => []);
        violations.push(...recorded.map((v) => `violation: ${v}`));
      }
      expect(violations, 'CSP violations').toEqual([]);
    },
    { auto: true },
  ],
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
