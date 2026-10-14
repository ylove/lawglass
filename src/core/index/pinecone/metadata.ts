import type { IntegratedRecord } from '@pinecone-database/pinecone';
import {
  ChunkFilter,
  StoredChunk,
  AppError,
  type Chunk,
} from '../../model/index.js';

const FIELDS = {
  docId: 'doc_id',
  sectionId: 'section_id',
  sectionNum: 'section_num',
  heading: 'heading',
  breadcrumb: 'breadcrumb',
  chunkType: 'chunk_type',
  amendmentStatus: 'amendment_status',
  text: 'text',
  pageStart: 'page_start',
  pageEnd: 'page_end',
  lineStart: 'line_start',
  lineEnd: 'line_end',
  definedTermsUsed: 'defined_terms_used',
  refs: 'refs',
  coveredSectionIds: 'covered_section_ids',
  definesTerm: 'defines_term',
  tokenCount: 'token_count',
} as const;
export const STORED_FIELDS = Object.values(FIELDS);

export function toRecord(chunk: Chunk): IntegratedRecord {
  const record: IntegratedRecord = {
    _id: chunk.id,
    embed_text: chunk.embedText,
  };
  for (const [key, field] of Object.entries(FIELDS)) {
    const value = chunk[key as keyof typeof FIELDS];
    if (value !== undefined) record[field] = value;
  }
  // Integrated text is retained as metadata too, so include it in the 40 KB budget.
  const { _id: _omit, ...metadata } = record;
  if (
    chunk.id.length > 512 ||
    Buffer.byteLength(JSON.stringify(metadata)) > 40 * 1024
  )
    throw new AppError('TOO_LARGE', 'A chunk exceeds Pinecone record limits.');
  return record;
}

export function fromRecord(
  id: string,
  fields: unknown,
  docId: string,
): StoredChunk {
  if (typeof fields !== 'object' || fields === null)
    throw new AppError('BACKEND_UNAVAILABLE');
  const metadata = fields as Record<string, unknown>;
  const chunk: Record<string, unknown> = { id };
  for (const [key, field] of Object.entries(FIELDS)) {
    if (metadata[field] !== undefined) chunk[key] = metadata[field];
  }
  const parsed = StoredChunk.safeParse(chunk);
  if (!parsed.success || parsed.data.docId !== docId)
    throw new AppError(
      'BACKEND_UNAVAILABLE',
      'Pinecone returned invalid chunk metadata.',
    );
  return parsed.data;
}

export function translateFilter(
  filter: ChunkFilter | undefined,
): object | undefined {
  if (!filter) return undefined;
  const parsed = ChunkFilter.safeParse(filter);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const clauses: Record<string, { $in: string[] }>[] = [];
  const fields = {
    chunkType: 'chunk_type',
    amendmentStatus: 'amendment_status',
    sectionIds: 'section_id',
    definesTerm: 'defines_term',
  } as const;
  for (const [key, field] of Object.entries(fields)) {
    const values = parsed.data[key as keyof typeof fields];
    if (values) {
      if (values.length > 10_000) throw new AppError('INVALID_INPUT');
      clauses.push({ [field]: { $in: values } });
    }
  }
  return clauses.length === 0 ? undefined : { $and: clauses };
}
