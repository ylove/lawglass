/**
 * GET /api/docs/:docId/summary/pictures and GET /api/docs/:docId/breakdown/pictures (#344).
 * Kept out of app.ts, which registers them with one line, like the breakdown routes.
 */
import type { Context, Hono } from 'hono';
import type { CliRuntime } from '../cli/runtime.js';
import { AppError } from '../core/model/index.js';
import type { PictureSource } from '../core/picture/cache.js';
import type { BreakdownService } from './breakdown.js';
import {
  createPictureService,
  type PictureLogEvent,
  type PictureService,
} from './pictures.js';
import type { SummaryService } from './summary.js';

export function registerPictureRoutes(
  app: Hono,
  runtime: CliRuntime,
  options: {
    publicMode: boolean;
    now?: (() => number) | undefined;
    summary: SummaryService;
    breakdown: BreakdownService;
    waitMs?: number | undefined;
    onError?: (c: Context, error: unknown, ms: number) => void;
    log?: ((event: PictureLogEvent) => void) | undefined;
    service?: PictureService;
  },
): PictureService {
  const service =
    options.service ??
    createPictureService(runtime, {
      publicMode: options.publicMode,
      summary: options.summary,
      breakdown: options.breakdown,
      now: options.now,
      waitMs: options.waitMs,
      log: options.log,
    });

  const known = async (docId: string): Promise<string> => {
    const entry = (await runtime.registry.list()).find(
      (e) => e.docId === docId,
    );
    if (!entry) throw new AppError('DOC_NOT_FOUND');
    return entry.docId;
  };

  for (const source of [
    'summary',
    'breakdown',
  ] as const satisfies readonly PictureSource[])
    app.get(`/api/docs/:docId/${source}/pictures`, async (c) => {
      const docId = await known(c.req.param('docId'));
      return c.json(
        await service.get(docId, source, {
          wait: c.req.method !== 'HEAD',
          signal: c.req.raw.signal,
          onError: (error, ms) => options.onError?.(c, error, ms),
        }),
      );
    });
  return service;
}
