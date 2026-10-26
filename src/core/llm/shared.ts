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

/**
 * A provider failure that remembers one thing about the cause: the HTTP status, when there was
 * one. "400" and "429" need different fixes, and a status is a number, so it can never carry a
 * key, a header or the request. Lives here rather than in the frozen `AppError` contract.
 */
export class ProviderFailure extends AppError {
  readonly providerStatus: number | undefined;
  constructor(
    code: 'PROVIDER_ERROR' | 'PROVIDER_BAD_OUTPUT',
    providerStatus?: number,
  ) {
    super(code);
    this.providerStatus = providerStatus;
  }
}

/** The HTTP status of an SDK error (all three SDKs set `status`), or undefined. */
function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error))
    return undefined;
  const { status } = error;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? status
    : undefined;
}

/** For log lines: a provider failure's HTTP status, or undefined for anything else. */
export function providerStatusOf(error: unknown): number | undefined {
  return error instanceof ProviderFailure ? error.providerStatus : undefined;
}

/** SDK errors can contain headers, credentials and request bodies, even in their cause. */
export function providerFailure(error: unknown): AppError {
  if (error instanceof AppError && error.code === 'PROVIDER_BAD_OUTPUT')
    return new ProviderFailure('PROVIDER_BAD_OUTPUT');
  return new ProviderFailure('PROVIDER_ERROR', httpStatus(error));
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

/**
 * The body of a ```json fenced block, or undefined. Done by hand: the equivalent regex
 * (`\s*([\s\S]*?)\s*` between the fences) backtracks quadratically on whitespace runs.
 */
function unfence(text: string): string | undefined {
  if (text.length < 6 || !text.startsWith('```') || !text.endsWith('```'))
    return undefined;
  let inner = text.slice(3, -3);
  if (inner.slice(0, 4).toLowerCase() === 'json') inner = inner.slice(4);
  return inner.trim();
}

/** Plain-prompt compatibility also accepts fenced JSON or one JSON value surrounded by prose. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = unfence(trimmed);
  try {
    return JSON.parse(fenced ?? trimmed) as unknown;
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
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (usage.input_tokens ?? 0) + cacheWrite + cacheRead,
    outputTokens: usage.output_tokens ?? 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
