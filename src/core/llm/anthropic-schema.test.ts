import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { httpReplay, KEY } from '../../../tests/llm/http.js';
import { BriefBatch } from '../breakdown/generate.js';
import { ExtractedMetadata } from '../enrich/metadata.js';
import { Selection } from '../locate/prompt.js';
import { AppError, Scenario } from '../model/index.js';
import { AnthropicProvider } from './anthropic.js';
import {
  ANTHROPIC_SCHEMA_KEYWORDS,
  anthropicSchema,
} from './anthropic-schema.js';

/** Every schema the app sends to `generateObject`, by its `schemaName`. */
const SENT_SCHEMAS: Record<string, z.ZodType> = {
  section_briefs: BriefBatch,
  scenario: Scenario,
  locate: Selection,
  bill_metadata: ExtractedMetadata,
};

/** A recorded Messages API reply whose text is `text`. */
function reply(text: string) {
  return {
    body: JSON.stringify({
      id: 'msg_recorded',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 8 },
    }),
  };
}

/** The schema the provider put on the wire for one `generateObject` call. */
async function sentSchema(
  schema: z.ZodType,
  text = '{}',
): Promise<{ schema: Record<string, unknown>; result: Promise<unknown> }> {
  const replay = httpReplay([reply(text)]);
  const provider = new AnthropicProvider(
    { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: KEY },
    { fetch: replay.fetch },
  );
  const result = provider
    .generateObject({
      system: 's',
      prompt: 'p',
      schema,
      schemaName: 'test',
      maxTokens: 100,
    })
    .then(
      (r) => r,
      (e: unknown) => e,
    );
  await result;
  const body = (await replay.requests[0]!.json()) as {
    output_config: { format: { schema: Record<string, unknown> } };
  };
  return { schema: body.output_config.format.schema, result };
}

/** Every keyword used at a schema position (not inside `properties` names or `enum` values). */
function keywords(schema: unknown, found = new Set<string>()): Set<string> {
  if (typeof schema !== 'object' || schema === null) return found;
  const node = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    if (key === 'properties' || key === '$defs')
      for (const child of Object.values(value as object))
        keywords(child, found);
    else if (key === 'items') keywords(value, found);
    else if (key === 'anyOf' || key === 'allOf')
      for (const child of value as unknown[]) keywords(child, found);
  }
  return found;
}

describe('anthropicSchema', () => {
  it('drops the limits the API refuses and keeps closed sets', () => {
    const out = anthropicSchema(
      z.toJSONSchema(
        z.object({
          name: z.string().min(1).max(20),
          code: z.string().regex(/^[a-z]+$/),
          count: z.number().int().min(1).max(8),
          kind: z.enum(['a', 'b']),
          sure: z.literal(true),
          when: z.iso.datetime(),
          site: z.url(),
          list: z.array(z.string()).min(3).max(4),
          some: z.array(z.string()).min(1),
          maybe: z.string().nullable().optional(),
        }),
      ),
    );
    expect(out).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        code: { type: 'string' },
        count: { type: 'integer' },
        kind: { type: 'string', enum: ['a', 'b'] },
        sure: { type: 'boolean', const: true },
        when: { type: 'string', format: 'date-time' },
        site: { type: 'string', format: 'uri' },
        list: { type: 'array', items: { type: 'string' } },
        some: { type: 'array', items: { type: 'string' }, minItems: 1 },
        // The API accepts a type list; hosted metadata extraction has always sent one.
        maybe: { type: ['string', 'null'] },
      },
      required: [
        'name',
        'code',
        'count',
        'kind',
        'sure',
        'when',
        'site',
        'list',
        'some',
      ],
      additionalProperties: false,
    });
  });

  it('turns oneOf into anyOf and drops unknown formats', () => {
    expect(
      anthropicSchema({
        oneOf: [
          { type: 'string', format: 'regex' },
          { type: 'object', properties: {}, additionalProperties: true },
        ],
      }),
    ).toEqual({
      anyOf: [
        { type: 'string' },
        { type: 'object', properties: {}, additionalProperties: false },
      ],
    });
    expect(anthropicSchema('not a schema')).toEqual({});
  });
});

describe('every structured-output schema the app sends (#341)', () => {
  it.each(Object.entries(SENT_SCHEMAS))(
    '%s goes out with supported keywords only',
    async (_name, schema) => {
      const { schema: sent } = await sentSchema(schema);
      const used = [...keywords(sent)];
      expect(used.filter((k) => !ANTHROPIC_SCHEMA_KEYWORDS.has(k))).toEqual([]);
    },
  );

  it('still sends the closed sets as enums', async () => {
    const { schema } = await sentSchema(Scenario);
    const text = JSON.stringify(schema);
    expect(text).toContain('"enum":["setup","rule","effect"]');
    expect(text).toContain('"const":true');
  });

  it('still refuses a reply that breaks a limit the API was not sent', async () => {
    const { result } = await sentSchema(
      Selection,
      JSON.stringify({
        matches: [{ passage: 9, quote: 'q', explanation: 'e [S:sec-1]' }],
        notFound: false,
      }),
    );
    expect(await result).toEqual(new AppError('PROVIDER_BAD_OUTPUT'));
  });

  it('covers every schemaName in the source tree', () => {
    const root = join(import.meta.dirname, '..', '..');
    /** schemaName -> the file it is sent from. */
    const names = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name)
        )
          for (const m of readFileSync(path, 'utf8').matchAll(
            /schemaName:\s*'([^']+)'/g,
          ))
            names.set(m[1] ?? '', relative(root, path));
      }
    };
    walk(root);
    const uncovered = [...names].filter(([name]) => !(name in SENT_SCHEMAS));
    // A new structured-output call must be added to SENT_SCHEMAS above.
    expect(uncovered).toEqual([]);
  });
});
