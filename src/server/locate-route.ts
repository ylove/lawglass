import type { Hono, Context } from 'hono';
import type { CliRuntime } from '../cli/runtime.js';
import {
  AppError,
  LocateRequest,
  LocateResponse,
  LocateVersionsResponse,
} from '../core/model/index.js';
import { locate, cleanSentence } from '../core/locate/index.js';
import { locateVersions } from '../core/locate/versions.js';
import { readHistory } from '../core/history/history-store.js';

export function registerLocateRoute(
  app: Hono,
  runtime: CliRuntime,
  options: {
    publicMode: boolean;
    rateLimit: (c: Context) => boolean;
    validateUrl?: ((url: URL) => void) | undefined;
  },
): void {
  for (const versions of [false, true]) {
    app.post(
      `/api/docs/:docId/locate${versions ? '/versions' : ''}`,
      async (c) => {
        const docId = c.req.param('docId');
        if (!(await runtime.registry.list()).some((e) => e.docId === docId))
          throw new AppError('DOC_NOT_FOUND');
        if (options.publicMode)
          return c.json(
            versions
              ? LocateVersionsResponse.parse({
                  status: 'disabled',
                  versions: [],
                })
              : LocateResponse.parse({
                  status: 'disabled',
                  matches: [],
                  provider: 'none',
                  model: 'none',
                }),
          );
        const parsed = LocateRequest.safeParse(
          await c.req.json().catch(() => undefined),
        );
        if (!parsed.success)
          throw new AppError(
            'INVALID_INPUT',
            'Paste one sentence (3 to 500 characters).',
          );
        const text = cleanSentence(parsed.data.text);
        if (!options.rateLimit(c)) throw new AppError('RATE_LIMITED');
        if (versions) {
          const result = await locateVersions(
            text,
            await readHistory(runtime.registry.configDir, docId),
            {
              fetcher: runtime.fetcher,
              parsePdf: runtime.parsePdf,
              validateUrl: options.validateUrl,
              signal: c.req.raw.signal,
            },
          );
          return c.json(LocateVersionsResponse.parse(result));
        }
        const result = await locate(docId, text, {
          backend: runtime.backend,
          provider: runtime.answerProvider,
          registry: runtime.registry,
          signal: c.req.raw.signal,
        });
        return c.json(LocateResponse.parse(result));
      },
    );
  }
}
