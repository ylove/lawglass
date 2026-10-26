import { ClientConfig } from '../core/model/index.js';
import { envVar } from '../core/brand.js';

/**
 * Example bills for the homepage, from a JSON array of `{label, url}` in the environment.
 * A bad value is reported once and ignored: the homepage just has no examples line.
 */
export function readExamples(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
  now: () => number,
): ClientConfig['examples'] {
  const raw = env[envVar('EXAMPLES')];
  if (raw === undefined || raw.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const parsed = ClientConfig.shape.examples.safeParse(value);
  if (parsed.success && parsed.data) return parsed.data;
  // Only the variable name is logged, never its contents.
  write(
    JSON.stringify({
      t: new Date(now()).toISOString(),
      level: 'warn',
      event: 'examples_invalid',
      variable: envVar('EXAMPLES'),
    }) + '\n',
  );
  return undefined;
}
