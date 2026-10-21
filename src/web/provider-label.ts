/**
 * Footer data note: who receives bill text and questions. Returns null for the mock provider
 * (nothing leaves the machine) so no claim is shown.
 */
export function dataNote(provider: string): string | null {
  switch (provider) {
    case 'anthropic':
      return sentTo('Anthropic');
    case 'openai':
      // The openai adapter also serves OpenAI-compatible endpoints (Ollama, OpenRouter, ...),
      // so name no vendor we cannot be sure of.
      return sentTo('your configured OpenAI-compatible provider');
    case 'google':
      return sentTo('Google');
    case 'claude-cli':
      return sentTo('Claude through your local Claude Code');
    default:
      return null;
  }
}

function sentTo(who: string): string {
  return `Bill text and your questions are sent to ${who} to write answers.`;
}
