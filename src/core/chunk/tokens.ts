/** Conservative sizing without a tokenizer or a model download. */
export function estimateTokens(text: string): number {
  const words = text.match(/\S+/g)?.length ?? 0;
  return Math.max(Math.ceil(words * 1.3), Math.ceil(text.length / 4));
}
