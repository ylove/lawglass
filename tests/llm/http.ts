import { readFileSync } from 'node:fs';
import type {
  LlmProvider,
  LlmStreamEvent,
  TextRequest,
} from '../../src/core/model/index.js';

export const KEY = 'test-provider-key';
export const textRequest: TextRequest = {
  system: 'One short sentence.',
  messages: [{ role: 'user', content: 'Hello' }],
  maxTokens: 50,
};
export function asset(name: string): string {
  return readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8');
}
export async function drain(
  provider: LlmProvider,
  req = textRequest,
): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of provider.streamText(req)) events.push(event);
  return events;
}
export interface RecordedReply {
  body: string;
  status?: number;
  stream?: boolean;
}
export function httpReplay(replies: RecordedReply[]) {
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const reply = replies.shift();
    if (!reply) throw new Error('No recorded reply');
    const bytes = new TextEncoder().encode(reply.body);
    let offset = 0;
    // Fragment the bytes across SSE/JSON boundaries to exercise real SDK parsers.
    const body = reply.stream
      ? new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.slice(offset, offset + 17));
            offset += 17;
          },
        })
      : reply.body;
    await Promise.resolve();
    return new Response(body, {
      status: reply.status ?? 200,
      headers: {
        'content-type': reply.stream ? 'text/event-stream' : 'application/json',
      },
    });
  };
  return { fetch: fetcher, requests };
}
