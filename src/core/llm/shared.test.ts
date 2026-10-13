import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../model/index.js';
import {
  anthropicUsage,
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
    for (const timeout of [0, -1, NaN])
      expect(() => requestSignal(undefined, timeout)).toThrow(
        new AppError('INVALID_INPUT'),
      );
    expect(() => requestSignal(AbortSignal.abort())).toThrow(
      new AppError('PROVIDER_ERROR'),
    );
    expect(requestSignal().aborted).toBe(false);
    const ac = new AbortController();
    const combined = requestSignal(ac.signal);
    ac.abort();
    expect(combined.aborted).toBe(true);
  });
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
