import { fetch } from 'undici';
import { afterAll, vi } from 'vitest';
import './setup.fetch.js';

// Happy-dom's fetch bypasses Undici's dispatcher; use the guarded implementation.
vi.stubGlobal('fetch', fetch);
afterAll(() => vi.unstubAllGlobals());
