/**
 * POST /api/docs/:docId/scenario: an illustrated example for a subject the reader names.
 * Kept out of app.ts, which several other changes are editing; app.ts registers it with one line.
 */
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { CliRuntime } from '../cli/runtime.js';
import { AnswerCache } from '../core/answer-cache.js';
import {
  AppError,
  ScenarioRequest,
  type ScenarioResponse,
} from '../core/model/index.js';
import { runScenario } from '../core/pipeline/index.js';
import { SUMMARY_CACHE_VERSION } from './summary.js';

export function registerScenarioRoute(
  app: Hono,
  runtime: CliRuntime,
  options: { publicMode: boolean; now?: (() => number) | undefined },
): void {
  app.post('/api/docs/:docId/scenario', async (c) => {
    // Public servers never start a model call for a visitor, so there is nothing to serve.
    if (options.publicMode)
      return c.json<ScenarioResponse>({ status: 'disabled' });
    const parsed = ScenarioRequest.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      const message = 'Enter who the example is about (up to 80 characters).';
      throw new AppError('INVALID_INPUT', message, { userMessage: message });
    }
    const docId = c.req.param('docId');
    const known = (await runtime.registry.list()).some(
      (e) => e.docId === docId,
    );
    if (!known) throw new AppError('DOC_NOT_FOUND');
    const provider = runtime.answerProvider;

    const answers = new AnswerCache({
      dir: join(runtime.registry.configDir, 'cache', 'answers'),
    });
    const result = await runScenario(docId, parsed.data.subject, {
      backend: runtime.backend,
      provider,
      registry: runtime.registry,
      retrievalMode: runtime.retrievalMode,
      now: options.now,
      signal: c.req.raw.signal,
      // Passages the cached summary cited anchor the example in what the reader already saw.
      summaryChunkIds: async () => {
        const summary = await answers.get({
          docId,
          chipId: 'summary',
          provider: provider.id,
          model: provider.model,
          promptVersion: SUMMARY_CACHE_VERSION,
        });
        return (summary?.citations ?? [])
          .filter((citation) => citation.valid)
          .flatMap((citation) => citation.chunkIds);
      },
    });
    return c.json(result);
  });
}
