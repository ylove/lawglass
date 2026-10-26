import type { LlmProvider, ObjectRequest } from '../../src/core/model/index.js';

/** A provider whose structured replies the test scripts, in order; an Error is thrown. */
export function scriptedObjects(
  replies: unknown[],
): LlmProvider & { calls: ObjectRequest<unknown>[] } {
  const calls: ObjectRequest<unknown>[] = [];
  return {
    id: 'anthropic',
    model: 'claude-haiku-5-5',
    calls,
    // Pictures never stream; a call here is a bug in the test subject.

    async *streamText() {
      await Promise.resolve();
      throw new Error('streamText is not scripted');
    },
    generateObject<T>(req: ObjectRequest<T>) {
      calls.push(req);
      const next = replies.length > 1 ? replies.shift() : replies[0];
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({
        object: next as T,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
}
