/**
 * Question hygiene, enforced in core so the CLI, server and MCP all get it.
 */
import { AppError } from '../model/index.js';

/** The same cap as the HTTP request schema. */
export const MAX_QUESTION_LENGTH = 500;

/**
 * Bidirectional controls and invisible/zero-width characters. They let a question look
 * different from what the model (or a terminal) receives, so they are removed before
 * retrieval, the prompt and any echo. Keep in step with `src/cli/sanitize.ts`.
 */
const INVISIBLES = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function stripInvisibles(text: string): string {
  return text.replace(INVISIBLES, '');
}

/** Returns the cleaned question, or throws INVALID_INPUT when empty or over the cap. */
export function cleanQuestion(raw: string): string {
  // Measure the raw input: padding with invisible characters must not dodge the cap.
  if (raw.length > MAX_QUESTION_LENGTH)
    throw new AppError('INVALID_INPUT', 'Question too long.', {
      userMessage: `Keep the question to ${String(MAX_QUESTION_LENGTH)} characters or fewer.`,
    });
  const question = stripInvisibles(raw).trim();
  if (!question)
    throw new AppError('INVALID_INPUT', 'Empty question.', {
      userMessage: 'Enter a question to ask.',
    });
  return question;
}
