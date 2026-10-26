/**
 * The JSON Schema subset that Anthropic structured output accepts (#341).
 *
 * `z.toJSONSchema()` writes every zod limit as a keyword: `minLength`, `maxLength`, `maxItems`,
 * `minimum`, `maximum`, `pattern`. The API refuses a schema that has any of them with a 400, so
 * every constrained `generateObject` call failed on the hosted server (section briefs, examples,
 * "Find where it says that") while the claude-cli provider, which sends the schema as prompt
 * text, never noticed.
 *
 * This keeps only what the API documents as supported and drops the rest. Nothing gets looser:
 * every reply is still parsed with the full zod schema (`validateObject`). Unlike the SDK's
 * `transformJSONSchema`, `enum` and `const` stay real keywords instead of becoming description
 * text, so the API still constrains the closed sets (icon ids, statuses) that matter most.
 */

/** String formats the API supports; any other `format` is dropped. */
const FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/** Keywords copied as they are: their values are data, never nested schemas. */
const PLAIN = ['type', 'enum', 'const', 'required', 'description', 'title'];

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapValues(value: unknown): Schema | undefined {
  if (!isSchema(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, anthropicSchema(child)]),
  );
}

export function anthropicSchema(schema: unknown): Schema {
  if (!isSchema(schema)) return {};
  const out: Schema = {};
  for (const key of PLAIN) if (key in schema) out[key] = schema[key];
  if (typeof schema.$ref === 'string') out.$ref = schema.$ref;
  const defs = mapValues(schema.$defs);
  if (defs) out.$defs = defs;
  const properties = mapValues(schema.properties);
  if (properties) out.properties = properties;
  if (isSchema(schema.items)) out.items = anthropicSchema(schema.items);
  // `oneOf` is not supported; for our schemas (discriminated by a literal) `anyOf` means the same.
  for (const [from, to] of [
    ['anyOf', 'anyOf'],
    ['oneOf', 'anyOf'],
    ['allOf', 'allOf'],
  ] as const) {
    const list = schema[from];
    if (Array.isArray(list)) out[to] = list.map((s) => anthropicSchema(s));
  }
  if (typeof schema.format === 'string' && FORMATS.has(schema.format))
    out.format = schema.format;
  if (schema.minItems === 0 || schema.minItems === 1)
    out.minItems = schema.minItems;
  // The API requires `additionalProperties: false` on every object.
  if (schema.type === 'object' || properties) out.additionalProperties = false;
  return out;
}

/** Every keyword `anthropicSchema` can emit; the regression test checks sent schemas against it. */
export const ANTHROPIC_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  ...PLAIN,
  '$ref',
  '$defs',
  'properties',
  'items',
  'anyOf',
  'allOf',
  'format',
  'minItems',
  'additionalProperties',
]);
