import { test as base, expect, type Page } from '@playwright/test';
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
  // Fails any test during which any page of the browser context reports a Content-Security-Policy
  // violation. Violations go to Node through a context-level binding, so they survive navigations,
  // reloads and popups; an in-page array would be reset by each of those.
  cspGuard: [
    async ({ context }, use) => {
      const violations: string[] = [];
      await context.exposeBinding('reportCspViolation', (_source, report) => {
        violations.push(`violation: ${String(report)}`);
      });
      // A function, not a string: Playwright evaluates strings with eval(), which CSP would flag.
      await context.addInitScript(() => {
        const report = (
          globalThis as unknown as {
            reportCspViolation?: (text: string) => void;
          }
        ).reportCspViolation;
        document.addEventListener('securitypolicyviolation', (event) => {
          report?.(`${event.violatedDirective} blocked ${event.blockedURI}`);
        });
      });
      const watch = (page: Page) => {
        page.on('console', (message) => {
          if (/content security policy/i.test(message.text()))
            violations.push(`console: ${message.text()}`);
        });
        page.on('pageerror', (error) => {
          if (/content security policy/i.test(error.message))
            violations.push(`pageerror: ${error.message}`);
        });
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      await use(undefined);
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
