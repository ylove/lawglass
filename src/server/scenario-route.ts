/**
 * POST /api/docs/:docId/scenario: an illustrated example for a subject the reader names.
 * Kept out of app.ts, which several other changes are editing; app.ts registers it with one line.
 */
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { runInJob } from '../core/cost/index.js';
import type { Admitted } from './job-end.js';
import type { CliRuntime } from '../cli/runtime.js';
import { AnswerCache } from '../core/answer-cache.js';
import {
  AppError,
  ScenarioRequest,
  type ScenarioResponse,
} from '../core/model/index.js';
import { runScenario } from '../core/pipeline/index.js';
import { summaryCacheKey } from './summary.js';

export function registerScenarioRoute(
  app: Hono,
  runtime: CliRuntime,
  options: {
    publicMode: boolean;
    /** Per request: serve nothing that could cost money (like public mode). */
    readOnly?: ((c: Context) => boolean) | undefined;
    now?: (() => number) | undefined;
    /** Hosting hook: admission before the model call; returns the job scope to run in. */
    admit?:
      | ((c: Context, docId: string) => Promise<Admitted | undefined>)
      | undefined;
  },
): void {
  app.post('/api/docs/:docId/scenario', async (c) => {
    // Public servers never start a model call for a visitor, so there is nothing to serve.
    if (options.publicMode || options.readOnly?.(c))
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
    const admitted = await options.admit?.(c, docId);

    const answers = new AnswerCache({
      dir: join(runtime.registry.configDir, 'cache', 'answers'),
    });
    let failure: unknown;
    try {
      const result = await runInJob(admitted?.scope, () =>
        runScenario(docId, parsed.data.subject, {
          onAttemptFailed: (error) => {
            failure ??= error;
          },
          backend: runtime.backend,
          // Read inside the job scope, so a routed model applies.
          provider: runtime.answerProvider,
          registry: runtime.registry,
          retrievalMode: runtime.retrievalMode,
          now: options.now,
          signal: c.req.raw.signal,
          // Passages the cached summary cited anchor the example in what the reader already saw.
          summaryChunkIds: async () => {
            const summary = await answers.get(
              await summaryCacheKey(runtime, docId),
            );
            return (summary?.citations ?? [])
              .filter((citation) => citation.valid)
              .flatMap((citation) => citation.chunkIds);
          },
        }),
      );
      // The reader gets `none`, but only because the model could not be asked or failed: not a
      // decision about the bill, so the host should not keep what it held.
      if (failure !== undefined) await admitted?.settlement?.fail(failure);
      else if (c.req.raw.signal.aborted)
        await admitted?.settlement?.fail(undefined);
      else await admitted?.settlement?.end('ok');
      return c.json(result);
    } catch (error) {
      await admitted?.settlement?.fail(error);
      throw error;
    }
  });
}
