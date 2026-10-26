import { fetch } from 'undici';
import { afterAll, afterEach, vi } from 'vitest';
import './setup.fetch.js';
import { visit } from './support/web-routes.js';

// Happy-dom's fetch bypasses Undici's dispatcher; use the guarded implementation.
vi.stubGlobal('fetch', fetch);
afterAll(() => vi.unstubAllGlobals());

// Routes live in the address bar; every test starts on the homepage.
afterEach(() => {
  visit('/');
});
