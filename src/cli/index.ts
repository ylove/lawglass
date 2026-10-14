#!/usr/bin/env node
// Commander entrypoint for the local CLI.
import { createProgram } from './program.js';
import { safeText } from './sanitize.js';
import { AppError } from '../core/model/index.js';

try {
  await createProgram().parseAsync();
} catch (error) {
  console.error(
    error instanceof AppError
      ? safeText(error.userMessage)
      : 'The command could not be completed.',
  );
  process.exitCode = 1;
}
