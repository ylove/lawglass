import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

    if (
      /\.(pdf|docx|xml)$/i.test(file.path) &&
      file.size > 4 * 1024 &&
      !file.path.startsWith('tests/synth/')
    ) {
      violations.push(
        `${file.path}: document exceeds 4 KB outside tests/synth/`,
      );
    }

    const name = basename(file.path);
    if (
      (name === '.env' || name.startsWith('.env.')) &&
      name !== '.env.example'
    ) {
      violations.push(`${file.path}: environment files must never be tracked`);
    }

    if (name !== '.env.example') continue;
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
