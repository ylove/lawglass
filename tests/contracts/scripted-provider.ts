/**
 * Scripted LlmProvider test double: streams a fixed reply and returns preset objects by schema
 * name. Validates the provider contract suite and lets callers be unit-tested without a model.
 * (The shipped `mock` provider in core/llm is a separate, richer deterministic adapter.)
 */
import {
  AppError,
  type LlmProvider,
  type LlmStreamEvent,
  type ObjectRequest,
  type TextRequest,
} from '../../src/core/model/index.js';

export interface Script {
  /** Reply to stream; split on spaces into text events. A function gets the request. */
  reply?: string | ((req: TextRequest) => string);
  /** Objects returned by generateObject, keyed by `schemaName`. */
  objects?: Record<string, unknown>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new DOMException('The operation was aborted.', 'AbortError');
}

export class ScriptedProvider implements LlmProvider {
  readonly id = 'mock' as const;
  readonly model = 'scripted';
  /** Every request seen, for assertions. */
  readonly calls: (TextRequest | ObjectRequest<unknown>)[] = [];

  constructor(private readonly script: Script = {}) {}

  async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
    throwIfAborted(req.signal);
    this.calls.push(req);
    const reply =
      typeof this.script.reply === 'function'
        ? this.script.reply(req)
        : (this.script.reply ?? 'Hello.');
    const words = reply.split(/(?<= )/);
    for (const text of words) {
      await Promise.resolve();
      throwIfAborted(req.signal);
      yield { type: 'text', text };
    }
    yield {
      type: 'done',
      usage: { inputTokens: 1, outputTokens: words.length },
      stopReason: 'end_turn',
    };
  }

  generateObject<T>(req: ObjectRequest<T>): Promise<{
    object: T;
    usage: { inputTokens: number; outputTokens: number };
  }> {
    throwIfAborted(req.signal);
    this.calls.push(req);
    const parsed = req.schema.safeParse(this.script.objects?.[req.schemaName]);
    if (!parsed.success) {
      return Promise.reject(
        new AppError(
          'PROVIDER_BAD_OUTPUT',
          `no valid scripted object for ${req.schemaName}`,
        ),
      );
    }
    return Promise.resolve({
      object: parsed.data,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
}
