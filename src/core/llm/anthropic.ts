import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import {
  type LlmProvider,
  type LlmStreamEvent,
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
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      stream = this.client.messages.stream(
        {
          model: this.model,
          system: req.system,
          messages: [...req.messages],
          max_tokens: req.maxTokens,
          temperature: req.temperature,
        },
        { signal },
      );
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text', text: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      signal.throwIfAborted();
      yield {
        type: 'done',
        usage: anthropicUsage(message.usage),
        stopReason: message.stop_reason,
      };
    } catch (error) {
      throw providerFailure(error);
    } finally {
      stream?.abort();
    }
  }

  async generateObject<T>(req: ObjectRequest<T>) {
    try {
      const signal = requestSignal(req.signal, this.config.timeoutMs);
      // Native structured output is available in SDK 0.133.0; no tool execution is needed.
      const message = await this.client.messages.create(
        {
          model: this.model,
          system: req.system,
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens,
          output_config: {
            format: { type: 'json_schema', schema: jsonSchema(req.schema) },
          },
        },
        { signal },
      );
      signal.throwIfAborted();
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      return {
        object: validateObject(req.schema, parseJson(text)),
        usage: anthropicUsage(message.usage),
      };
    } catch (error) {
      throw providerFailure(error);
    }
  }
}
