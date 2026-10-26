/**
 * Shared contract suite for every LlmProvider adapter.
 *
 * Live adapters run this only when their key (or the `claude` binary) is available:
 *   describeProviderContract('anthropic', () => makeAnthropic(cfg), { skip: !process.env.ANTHROPIC_API_KEY });
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  type LlmProvider,
  type LlmStreamEvent,
} from '../../src/core/model/index.js';

export function describeProviderContract(
  name: string,
  makeProvider: () => LlmProvider | Promise<LlmProvider>,
  opts: { skip?: boolean; timeoutMs?: number } = {},
): void {
  const suite = opts.skip ? describe.skip : describe;
  suite(
    `LlmProvider contract: ${name}`,
    { timeout: opts.timeoutMs ?? 60_000 },
    () => {
      it('exposes its id and model', async () => {
        const p = await makeProvider();
        expect(p.id).toMatch(/^(anthropic|openai|google|claude-cli|mock)$/);
        expect(p.model.length).toBeGreaterThan(0);
      });

      it('streams text and ends with exactly one done event carrying usage', async () => {
        const p = await makeProvider();
        const events: LlmStreamEvent[] = [];
        for await (const e of p.streamText({
          system: 'Reply with one short sentence.',
          messages: [{ role: 'user', content: 'Say hello.' }],
          maxTokens: 50,
        })) {
          events.push(e);
        }
        const text = events.filter((e) => e.type === 'text');
        const done = events.filter((e) => e.type === 'done');
        expect(text.length).toBeGreaterThan(0);
        expect(done).toHaveLength(1);
        expect(events.at(-1)?.type).toBe('done');
        const last = done[0];
        if (last?.type === 'done') {
          expect(last.usage.inputTokens).toBeGreaterThanOrEqual(0);
          expect(last.usage.outputTokens).toBeGreaterThanOrEqual(0);
        }
      });

      it('accepts a message made of ordered parts with a cache hint', async () => {
        const p = await makeProvider();
        const events: LlmStreamEvent[] = [];
        for await (const e of p.streamText({
          system: 'Reply with one short sentence.',
          messages: [
            {
              role: 'user',
              content: [
                { text: 'Some shared context. ', cache: true },
                { text: 'Say hello.' },
              ],
            },
          ],
          maxTokens: 50,
        })) {
          events.push(e);
        }
        expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
        expect(events.at(-1)?.type).toBe('done');
      });

      it('returns a schema-valid object from generateObject', async () => {
        const p = await makeProvider();
        const schema = z.object({
          billNumber: z.string().nullable(),
          sponsors: z.array(z.string()).nullable(),
        });
        const { object, usage } = await p.generateObject({
          system: 'Extract fields. Return null for anything not stated.',
          prompt:
            'Text: "S. 202. Introduced by Senator Example." Extract billNumber and sponsors.',
          schema,
          schemaName: 'bill_fields',
          maxTokens: 200,
        });
        expect(schema.safeParse(object).success).toBe(true);
        expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
      });

      it('rejects when the signal is already aborted', async () => {
        const p = await makeProvider();
        const ac = new AbortController();
        ac.abort();
        const run = async () => {
          for await (const _e of p.streamText({
            system: 's',
            messages: [{ role: 'user', content: 'x' }],
            maxTokens: 5,
            signal: ac.signal,
          })) {
            // drain
          }
        };
        await expect(run()).rejects.toSatisfy(
          (e: unknown) =>
            (e instanceof Error && e.name === 'AbortError') ||
            e instanceof AppError,
        );
      });
    },
  );
}
