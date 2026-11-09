import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import {
  type LlmMessage,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmUsage,
  type ObjectRequest,
  type ProviderConfig,
  type TextRequest,
} from '../model/index.js';
import {
  anthropicUsage,
  jsonSchema,
  parseJson,
  providerFailure,
  requestSignal,
  requireKey,
  validateObject,
} from './shared.js';
import { anthropicSchema } from './anthropic-schema.js';

/**
 * Parts become text blocks; a `cache` part ends a prompt-cache prefix (system + everything up to
 * and including that block), so the same bill is billed at the cache-read rate on later questions.
 */
function anthropicMessage(m: LlmMessage): Anthropic.MessageParam {
  if (typeof m.content === 'string')
    return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((part) => ({
      type: 'text' as const,
      text: part.text,
      ...(part.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    })),
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(
    private readonly config: ProviderConfig,
    deps: { fetch?: typeof fetch } = {},
  ) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: requireKey(config.apiKey),
      authToken: null,
      baseURL: 'https://api.anthropic.com',
      timeout: config.timeoutMs,
      maxRetries: 0,
      logLevel: 'off',
      fetch: deps.fetch,
    });
  }

  async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
    let stream: MessageStream | undefined;
    let finished = false;
    // What the API has said so far: input from message_start, output from message_delta.
    let started: LlmUsage | undefined;
    let outputSoFar = 0;
    let chars = 0;
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      stream = this.client.messages.stream(
        {
          model: this.model,
          system: req.system,
          messages: req.messages.map(anthropicMessage),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === 'message_start')
          started = anthropicUsage(event.message.usage);
        if (event.type === 'message_delta')
          outputSoFar = event.usage.output_tokens;
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        )
          chars += event.delta.text.length;
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text', text: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      signal.throwIfAborted();
      finished = true;
      yield {
        type: 'done',
        usage: anthropicUsage(message.usage),
        stopReason: message.stop_reason,
      };
    } catch (error) {
      throw providerFailure(error);
    } finally {
      stream?.abort();
      if (!finished && started)
        req.onPartialUsage?.({
          ...started,
          outputTokens: Math.max(outputSoFar, Math.ceil(chars / 4)),
        });
    }
  }

  async generateObject<T>(req: ObjectRequest<T>) {
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      // Native structured output is available in SDK 0.133.0; no tool execution is needed. The
      // API accepts a subset of JSON Schema (#341); the reply is still checked with the full schema.
      const message = await this.client.messages.create(
        {
          model: this.model,
          system: req.system,
          messages: [anthropicMessage({ role: 'user', content: req.prompt })],
          max_tokens: req.maxTokens,
          output_config: {
            format: {
              type: 'json_schema',
              schema: anthropicSchema(jsonSchema(req.schema)),
            },
            ...(req.effort ? { effort: req.effort } : {}),
          },
        },
        { signal },
      );
      // The API billed this call whatever happens next; failures below carry its usage.
      const usage = anthropicUsage(message.usage);
      try {
        signal.throwIfAborted();
        const text = message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('');
        return {
          object: validateObject(req.schema, parseJson(text)),
          usage,
        };
      } catch (error) {
        throw providerFailure(error, usage);
      }
    } catch (error) {
      throw providerFailure(error);
    }
  }
}
