#!/usr/bin/env node
// Commander entrypoint for the local CLI.
import { createProgram } from './program.js';
import { AppError } from '../core/model/index.js';

try {
  await createProgram().parseAsync();
} catch (error) {
  console.error(error instanceof AppError ? error.userMessage : 'The command could not be completed.');
  process.exitCode = 1;
}
