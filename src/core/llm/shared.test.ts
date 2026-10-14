import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../model/index.js';
import {
  anthropicUsage,
  DEFAULT_TIMEOUT_MS,
  jsonSchema,
  parseJson,
  providerFailure,
  requestSignal,
  requireKey,
  validateObject,
} from './shared.js';

describe('provider boundary helpers', () => {
  it('validates objects without echoing invalid output', () => {
    expect(validateObject(z.string(), 'ok')).toBe('ok');
    expect(() => validateObject(z.number(), 'secret')).toThrow(
      new AppError('PROVIDER_BAD_OUTPUT'),
    );
    expect(() => jsonSchema(z.custom())).toThrow(
      new AppError('PROVIDER_BAD_OUTPUT'),
    );
  });
  it('parses JSON and fenced JSON only', () => {
    expect(parseJson('```json\n{"x":1}\n```')).toEqual({ x: 1 });
    expect(parseJson('[1]')).toEqual([1]);
    expect(() => parseJson('private body')).toThrow(
      new AppError('PROVIDER_BAD_OUTPUT'),
    );
  });
  it('extracts nested JSON from prose without truncating quoted braces', () => {
    expect(
      parseJson(
        'Here is JSON: {"x":[{"text":"brace } and \\" quote"}]} Thanks.',
      ),
    ).toEqual({ x: [{ text: 'brace } and " quote' }] });
    expect(parseJson('Result: [1, {"x":2}]')).toEqual([1, { x: 2 }]);
    for (const text of [
      'Result: {"x": [1}',
      '{unfinished',
      'Result: {"x":bad}',
    ])
      expect(() => parseJson(text)).toThrow(
        new AppError('PROVIDER_BAD_OUTPUT'),
      );
  });
  it('discards unsafe messages, details and causes', () => {
    for (const error of [
      new Error('secret'),
      new AppError('PROVIDER_ERROR', 'secret', {
        cause: 'secret',
        details: { key: 'secret' },
      }),
    ]) {
      const safe = providerFailure(error);
      expect(safe.code).toBe('PROVIDER_ERROR');
      expect(safe.message).not.toContain('secret');
      expect(safe.cause).toBeUndefined();
      expect(safe.details).toBeUndefined();
    }
    expect(providerFailure(new AppError('PROVIDER_BAD_OUTPUT')).code).toBe(
      'PROVIDER_BAD_OUTPUT',
    );
  });
  it('rejects absent keys and invalid timeouts', () => {
    expect(requireKey('test')).toBe('test');
    for (const key of [undefined, '', ' '])
      expect(() => requireKey(key)).toThrow(new AppError('MISSING_KEY'));
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    for (const timeout of [0, -1, NaN])
      expect(() => requestSignal(undefined, timeout, timeoutSignal)).toThrow(
        new AppError('INVALID_INPUT'),
      );
    expect(() =>
      requestSignal(AbortSignal.abort(), undefined, timeoutSignal),
    ).toThrow(new AppError('PROVIDER_ERROR'));
    expect(timeoutSignal).not.toHaveBeenCalled();
    expect(requestSignal().aborted).toBe(false);
    const ac = new AbortController();
    const combined = requestSignal(ac.signal);
    ac.abort();
    expect(combined.aborted).toBe(true);
  });
  it.each([undefined, 30])(
    'uses the injected timeout signal with timeout %s',
    (timeoutMs) => {
      const timeout = new AbortController();
      const timeoutSignal = vi.fn(() => timeout.signal);
      const signal = requestSignal(undefined, timeoutMs, timeoutSignal);
      expect(timeoutSignal).toHaveBeenCalledExactlyOnceWith(
        timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      expect(signal).toBe(timeout.signal);
      expect(signal.aborted).toBe(false);
      timeout.abort();
      expect(signal.aborted).toBe(true);
    },
  );
  it.each(['timeout', 'caller'] as const)(
    'combines caller cancellation with the injected timeout (%s aborts)',
    (source) => {
      const caller = new AbortController();
      const timeout = new AbortController();
      const signal = requestSignal(caller.signal, 30, () => timeout.signal);
      expect(signal.aborted).toBe(false);
      const controller = source === 'timeout' ? timeout : caller;
      controller.abort(new Error(source));
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(controller.signal.reason);
    },
  );
  it('counts cached input tokens', () => {
    expect(
      anthropicUsage({
        input_tokens: 2,
        output_tokens: 3,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      }),
    ).toEqual({ inputTokens: 14, outputTokens: 3 });
    expect(anthropicUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
