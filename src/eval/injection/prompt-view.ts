/** Reading a built prompt back the way a model would see it. */

export interface ModelView {
  system: string;
  user: string;
  /** The question as the model reads it (entities decoded). */
  question: string;
  excerpts: { section: string; text: string }[];
}

/** Inverse of `escapeText`. Order matters: `&amp;` last so `&amp;lt;` becomes `&lt;`. */
export function unescapeText(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

/** Parse the system and user message of an answer request into what the model sees. */
export function viewOf(system: string, user: string): ModelView {
  const question = /<question>([\s\S]*)<\/question>\s*$/.exec(user)?.[1] ?? '';
  const excerpts = [
    ...user.matchAll(/<excerpt ([^>]*)>([\s\S]*?)<\/excerpt>/g),
  ].map((m) => ({
    section: unescapeText(/section="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? ''),
    text: unescapeText(m[2] ?? ''),
  }));
  return { system, user, question: unescapeText(question), excerpts };
}
