import { z } from 'zod';
import {
  AppError,
  DECLINE_TEXT,
  type LlmProvider,
  type LlmStreamEvent,
  type ObjectRequest,
  type TextRequest,
  messageText,
} from '../model/index.js';
import { jsonSchema, validateObject } from './shared.js';
import { trimEndWhile } from '../trim.js';

const STOP_WORDS = new Set(
  'a an and are as at be bill by can do does for from how in is it may of on or shall that the their this to what when which who will with would'.split(
    ' ',
  ),
);
function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z]+/g) ?? []).filter(
      (w) => w.length > 2 && !STOP_WORDS.has(w),
    ),
  );
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('PROVIDER_ERROR');
}

/** Recognize only our excerpt delimiters; all other angle brackets are plain text. */
function parseExcerpts(prompt: string) {
  const excerpts: { attributes: string; text: string }[] = [];
  const question: string[] = [];
  let searchFrom = 0;
  let plainFrom = 0;
  while (searchFrom < prompt.length) {
    const start = prompt.indexOf('<excerpt', searchFrom);
    if (start === -1) break;
    const attributesFrom = start + '<excerpt'.length;
    searchFrom = attributesFrom;
    const boundary = prompt[attributesFrom];
    if (boundary !== '>' && !boundary?.match(/\s/)) continue;
    const openingEnd = prompt.indexOf('>', attributesFrom);
    if (openingEnd === -1) break;
    const attributes = prompt.slice(attributesFrom, openingEnd);
    if (attributes.includes('<')) continue;
    const closingStart = prompt.indexOf('</excerpt>', openingEnd + 1);
    if (closingStart === -1) break;
    question.push(prompt.slice(plainFrom, start));
    excerpts.push({
      attributes,
      text: prompt.slice(openingEnd + 1, closingStart),
    });
    searchFrom = closingStart + '</excerpt>'.length;
    plainFrom = searchFrom;
  }
  question.push(prompt.slice(plainFrom));
  return { question: question.join('\n'), excerpts };
}

function answer(req: TextRequest): string {
  const prompt = req.messages
    .filter((m) => m.role === 'user')
    .map((m) => messageText(m.content))
    .join('\n');
  const parsed = parseExcerpts(prompt);
  const question = words(parsed.question);
  const excerpts = parsed.excerpts
    .flatMap((excerpt) => {
      const section = /\bsection\s*=\s*["']([^"']+)["']/.exec(
        excerpt.attributes,
      )?.[1];
      if (
        !section ||
        !z
          .string()
          .regex(/^[^\s[\]]+$/)
          .safeParse(section).success
      )
        return [];
      const text = excerpt.text.replace(/\s+/g, ' ').trim();
      const score = [...words(text)].filter((w) => question.has(w)).length;
      return text && score > 0 ? [{ section, text, score }] : [];
    })
    .sort((a, b) => b.score - a.score);
  const selected = excerpts.slice(0, 2);
  if (!selected.length) return DECLINE_TEXT;
  return selected
    .map((excerpt) => {
      const sentence =
        /^.*?[.!?](?:\s|$)/.exec(excerpt.text)?.[0]?.trim() ?? excerpt.text;
      return `${trimEndWhile(sentence.slice(0, 220), (c) => '.!?'.includes(c))} [S:${excerpt.section}].`;
    })
    .join(' ');
}

/** Build conservative defaults from public JSON Schema, then let zod check refinements. */
function emptyValue(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return undefined;
  const node = schema as Record<string, unknown>;
  if (
    node.type === 'null' ||
    (Array.isArray(node.type) && node.type.includes('null'))
  )
    return null;
  if (Array.isArray(node.anyOf)) {
    if (
      node.anyOf.some(
        (branch: unknown) =>
          typeof branch === 'object' &&
          branch !== null &&
          'type' in branch &&
          branch.type === 'null',
      )
    )
      return null;
    return emptyValue(node.anyOf[0]);
  }
  if (node.default !== undefined) return node.default;
  if ('const' in node) return node.const;
  if (Array.isArray(node.enum))
    return node.enum.includes('none') ? 'none' : node.enum[0];
  if (node.type === 'array') return [];
  if (node.type === 'object') {
    const properties = node.properties as Record<string, unknown> | undefined;
    // Optional fields are left out: their empty defaults can break refinements (min(1)).
    const required = new Set(
      Array.isArray(node.required) ? (node.required as string[]) : [],
    );
    return Object.fromEntries(
      Object.entries(properties ?? {})
        .filter(([key]) => required.has(key))
        .map(([key, value]) => [key, emptyValue(value)]),
    );
  }
  if (node.type === 'string') return '';
  if (node.type === 'number' || node.type === 'integer') return 0;
  if (node.type === 'boolean') return false;
  return undefined;
}

export class MockProvider implements LlmProvider {
  readonly id = 'mock' as const;
  constructor(readonly model = 'deterministic') {}

  async *streamText(req: TextRequest): AsyncIterable<LlmStreamEvent> {
    checkAbort(req.signal);
    const reply = answer(req);
    const tokens = reply.match(/\S+\s*/g) ?? [];
    for (const text of tokens) {
      await Promise.resolve();
      checkAbort(req.signal);
      yield { type: 'text', text };
    }
    checkAbort(req.signal);
    yield {
      type: 'done',
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    };
  }

  generateObject<T>(req: ObjectRequest<T>) {
    checkAbort(req.signal);
    return Promise.resolve({
      object: validateObject(req.schema, emptyValue(jsonSchema(req.schema))),
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }
}
