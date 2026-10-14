import { z } from 'zod';
import { AppError, type LlmUsage } from '../model/index.js';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const ZERO_LLM_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

export function requestSignal(
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutSignal: typeof AbortSignal.timeout = (ms) => AbortSignal.timeout(ms),
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new AppError('INVALID_INPUT');
  if (signal?.aborted) throw new AppError('PROVIDER_ERROR');
  const timeout = timeoutSignal(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function requireKey(key: string | undefined): string {
  if (!key?.trim()) throw new AppError('MISSING_KEY');
  return key;
}

/** SDK errors can contain headers, credentials and request bodies, even in their cause. */
export function providerFailure(error: unknown): AppError {
  return new AppError(
    error instanceof AppError && error.code === 'PROVIDER_BAD_OUTPUT'
      ? 'PROVIDER_BAD_OUTPUT'
      : 'PROVIDER_ERROR',
  );
}

export function jsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema);
  } catch {
    throw new AppError('PROVIDER_BAD_OUTPUT');
  }
}

export function validateObject<T>(schema: z.ZodType<T>, object: unknown): T {
  const parsed = schema.safeParse(object);
  if (!parsed.success) throw new AppError('PROVIDER_BAD_OUTPUT');
  return parsed.data;
}

/** Plain-prompt compatibility also accepts fenced JSON or one JSON value surrounded by prose. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  } catch {
    // Scan balanced delimiters rather than using a greedy regex: braces inside JSON
    // strings and nested arrays/objects must not truncate the extracted value.
    const start = trimmed.search(/[\[{]/);
    if (start < 0) throw new AppError('PROVIDER_BAD_OUTPUT');
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) break;
        if (stack.length === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as unknown;
          } catch {
            break;
          }
        }
      }
    }
    throw new AppError('PROVIDER_BAD_OUTPUT');
  }
}

export function anthropicUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): LlmUsage {
  return {
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
}
