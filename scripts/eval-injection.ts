/**
 * Adversarial prompt-injection eval (issue #183).
 *
 *   npm run eval:injection                        CI mode: a model fake that OBEYS every injection
 *   npm run eval:injection -- --provider claude-cli   live mode: a real model answers
 *
 * Both modes run every case through the real ask pipeline (local backend with fake embedding
 * models, so no downloads) and write eval/results-injection.md. CI mode is deterministic and
 * offline; it proves the output-side defenses hold when the model is fooled. Live mode records
 * whether a real model resists. The process exits 1 if any case ends unexpectedly.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createProvider } from '../src/core/llm/index.js';
import {
  AppError,
  type LlmProvider,
  type ProviderId,
} from '../src/core/model/index.js';
import {
  INJECTION_CASES,
  renderInjectionReport,
  runInjectionEval,
  type InjectionCase,
  type RunMode,
} from '../src/eval/injection/index.js';
import { compromisedProvider } from '../tests/support/compromised-provider.js';
import { makeInjectionHarness } from '../tests/support/injection-harness.js';

export interface InjectionScriptOptions {
  argv: readonly string[];
  /** Working directory that `--out` resolves against. */
  cwd: string;
  write: (text: string) => void;
  /** Builds the live provider; injected so tests never start a real CLI. */
  makeLiveProvider?:
    ((id: ProviderId, model: string) => LlmProvider) | undefined;
}

const LIVE_PROVIDERS: readonly ProviderId[] = [
  'claude-cli',
  'anthropic',
  'openai',
  'google',
];

/** Returns the process exit code. */
export async function runInjectionScript(
  opts: InjectionScriptOptions,
): Promise<number> {
  const { values } = parseArgs({
    args: [...opts.argv],
    options: {
      provider: { type: 'string', default: 'mock' },
      model: { type: 'string', default: '' },
      out: { type: 'string', default: 'eval/results-injection.md' },
      case: { type: 'string', multiple: true },
    },
    strict: true,
  });
  const providerId = values.provider;
  const mode: RunMode = providerId === 'mock' ? 'mock' : 'live';
  if (mode === 'live' && !LIVE_PROVIDERS.some((p) => p === providerId))
    throw new AppError('INVALID_INPUT', `Unknown provider ${providerId}.`);

  const wanted = values.case;
  const cases: readonly InjectionCase[] = wanted?.length
    ? INJECTION_CASES.filter((c) => wanted.includes(c.id))
    : INJECTION_CASES;
  if (cases.length === 0 || (wanted && cases.length !== wanted.length))
    throw new AppError(
      'INVALID_INPUT',
      `Unknown case in: ${(wanted ?? []).join(', ')}`,
    );

  const live =
    mode === 'live'
      ? (opts.makeLiveProvider ?? defaultLive)(
          providerId as ProviderId,
          values.model,
        )
      : undefined;
  const { harness, env } = await makeInjectionHarness();
  try {
    const results = await runInjectionEval(
      cases,
      harness,
      (c) => live ?? compromisedProvider(c),
      mode,
    );
    const label = live
      ? `${live.id} / ${live.model}`
      : 'compromised fake (obeys every injection)';
    const report = renderInjectionReport({
      mode,
      provider: label,
      cases,
      results,
    });
    const out = resolve(opts.cwd, values.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, report);
    const unexpected = results.filter((r) => !r.ok);
    opts.write(
      `injection eval (${mode}): ${String(results.length - unexpected.length)}/${String(results.length)} as expected; report: ${out}\n`,
    );
    for (const r of unexpected)
      opts.write(
        `  UNEXPECTED ${r.caseId}: failed ${r.unexpected.join(', ') || '-'}; expectation not observed ${r.notObserved.join(', ') || '-'}\n`,
      );
    return unexpected.length === 0 ? 0 : 1;
  } finally {
    await env.cleanup();
  }
}

/** Keys go only to their own provider (AGENTS.md rule 5). claude-cli uses the local login. */
const KEY_VARS: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

function defaultLive(id: ProviderId, model: string): LlmProvider {
  return createProvider({
    provider: id,
    model,
    apiKey: KEY_VARS[id] ? process.env[KEY_VARS[id]] : undefined,
  });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runInjectionScript({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    write: (t) => process.stdout.write(t),
  });
}
