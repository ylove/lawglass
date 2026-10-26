/**
 * GET /api/docs/:docId/breakdown and GET /api/docs/:docId/sections/:sectionId/example.
 * Kept out of app.ts, which several other changes are editing; app.ts registers them with one line.
 */
import type { Context, Hono } from 'hono';
import type { CliRuntime } from '../cli/runtime.js';
import { AppError, isAppError } from '../core/model/index.js';
import type { SummaryService } from './summary.js';
import { createBreakdownService, type BreakdownService } from './breakdown.js';

/** How long a breakdown waits for the document's summary before starting anyway. */
const SUMMARY_SETTLE_MS = 3 * 60_000;

/**
 * Wait until the summary is done (cached, or given up on) so the breakdown never slows it. Asking
 * for the summary is what opening a document does anyway, so this also starts it if the reader's
 * own request has not arrived yet.
 */
export function settledSummary(
  summary: SummaryService,
  maxMs = SUMMARY_SETTLE_MS,
): (docId: string) => Promise<void> {
  return async (docId) => {
    // Real time, not the app's injectable clock: a frozen test clock must not loop forever.
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if ((await summary.get(docId)).status !== 'pending') return;
    }
  };
}

export function registerBreakdownRoutes(
  app: Hono,
  runtime: CliRuntime,
  options: {
    publicMode: boolean;
    now?: (() => number) | undefined;
    summary: SummaryService;
    waitMs?: number | undefined;
    onError?: (c: Context, error: unknown, ms: number) => void;
    service?: BreakdownService;
  },
): BreakdownService {
  const now = options.now ?? Date.now;
  const service =
    options.service ??
    createBreakdownService(runtime, {
      publicMode: options.publicMode,
      now,
      waitMs: options.waitMs,
      afterSummary: settledSummary(options.summary),
    });

  const known = async (docId: string): Promise<string> => {
    const entry = (await runtime.registry.list()).find(
      (e) => e.docId === docId,
    );
    if (!entry) throw new AppError('DOC_NOT_FOUND');
    return entry.docId;
  };

  app.get('/api/docs/:docId/breakdown', async (c) => {
    const docId = await known(c.req.param('docId'));
    return c.json(
      await service.get(docId, {
        wait: c.req.method !== 'HEAD',
        signal: c.req.raw.signal,
        onError: (error, ms) => options.onError?.(c, error, ms),
      }),
    );
  });

  app.get('/api/docs/:docId/sections/:sectionId/example', async (c) => {
    const docId = await known(c.req.param('docId'));
    try {
      return c.json(
        await service.example(docId, c.req.param('sectionId'), {
          wait: c.req.method !== 'HEAD',
          signal: c.req.raw.signal,
          onError: (error, ms) => options.onError?.(c, error, ms),
        }),
      );
    } catch (error) {
      // Same shape as the section route: an unknown part is a 404, not a server error.
      if (isAppError(error) && error.code === 'INVALID_INPUT')
        return c.json(
          { error: { code: error.code, message: error.userMessage } },
          404,
        );
      throw error;
    }
  });
  return service;
}
