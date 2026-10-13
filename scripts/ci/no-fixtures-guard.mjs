import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Committed env templates: allowed, but every value must be empty. */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

/**
 * Inspect only tracked files; downloaded local fixtures are deliberately ignored.
 * @param {Array<{path: string, size: number, content?: string}>} files
 * @returns {string[]} Violations without any environment variable values.
 */
export function findViolations(files) {
  const violations = [];

  for (const file of files) {
    if (file.path.startsWith('fixtures/downloads/')) {
      violations.push(
        `${file.path}: downloaded fixtures must never be tracked`,
      );
    }

    // Binary documents are never legitimate source files here: reject them at any size.
    // XML can be legitimate config/test data, so only large XML (a likely bill) is rejected.
    const outsideSynth = !file.path.startsWith('tests/synth/');
    if (/\.(pdf|docx|doc|rtf)$/i.test(file.path) && outsideSynth) {
      violations.push(
        `${file.path}: binary documents must not be tracked outside tests/synth/`,
      );
    } else if (
      /\.xml$/i.test(file.path) &&
      file.size > 4 * 1024 &&
      outsideSynth
    ) {
      violations.push(
        `${file.path}: document exceeds 4 KB outside tests/synth/`,
      );
    }

    const name = basename(file.path);
    if (
      (name === '.env' || name === '.envrc' || name.startsWith('.env.')) &&
      !ENV_TEMPLATES.has(name)
    ) {
      violations.push(`${file.path}: environment files must never be tracked`);
    }

    if (!ENV_TEMPLATES.has(name)) continue;
    if (file.content === undefined) {
      violations.push(`${file.path}: example environment contents are missing`);
      continue;
    }

    for (const [index, rawLine] of file.content.split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const assignment =
        /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      const value = assignment?.[1];
      // Allow empty assignments, empty quotes and comments, but fail closed on
      // malformed or multiline entries so they cannot hide a populated value.
      if (
        value === undefined ||
        !/^(?:#.*|(["'])\1(?:\s+#.*)?)?$/.test(value)
      ) {
        violations.push(
          `${file.path}:${index + 1}: example environment entries must have empty values`,
        );
      }
    }
  }

  return violations;
}

function main() {
  // NUL delimiters preserve filenames containing spaces or newlines.
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const files = paths.map((path) => ({
    path,
    size: statSync(path).size,
    ...(basename(path) === '.env.example'
      ? { content: readFileSync(path, 'utf8') }
      : {}),
  }));
  const violations = findViolations(files);
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('No tracked fixtures or populated environment files found.');
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
