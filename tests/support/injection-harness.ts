/** Wires the injection runner to the shared pipeline harness (real LocalBackend, fake models). */
import type { InjectionHarness } from '../../src/eval/injection/index.js';
import { ingest } from '../../src/core/pipeline/ingest.js';
import { makePipelineEnv, type PipelineEnv } from './pipeline-env.js';

export async function makeInjectionHarness(): Promise<{
  harness: InjectionHarness;
  env: PipelineEnv;
}> {
  const env = await makePipelineEnv();
  const harness: InjectionHarness = {
    ingest: async (html, url) => {
      env.serve(url, { bytes: new TextEncoder().encode(html) }, 'text/html');
      const { runtime } = env;
      const { doc } = await ingest(url, {
        backend: runtime.backend,
        provider: runtime.extractProvider,
        registry: runtime.registry,
        fetcher: runtime.fetcher,
        now: runtime.now,
      });
      return doc.docId;
    },
    deps: (provider) => ({
      backend: env.backend,
      registry: env.registry,
      provider,
    }),
  };
  return { harness, env };
}
