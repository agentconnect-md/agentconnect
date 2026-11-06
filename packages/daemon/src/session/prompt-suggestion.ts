/** Longest predicted prompt any surface receives; a prediction is one short follow-up, never a document. */
export const MAX_PROMPT_SUGGESTION_CHARS = 500

/** The runtime's predicted next prompt on a `session_info_update`: text to show, `null` to clear, `undefined` when the update carries none. */
export function promptSuggestionOf(update: unknown): string | null | undefined {
  const u = update as { sessionUpdate?: unknown; _meta?: { promptSuggestions?: { suggestions?: unknown } } } | null
  if (u?.sessionUpdate !== 'session_info_update') return undefined
  const suggestions = u._meta?.promptSuggestions?.suggestions
  if (!Array.isArray(suggestions)) return undefined
  for (const s of suggestions) {
    const text = typeof (s as { text?: unknown })?.text === 'string' ? (s as { text: string }).text.trim() : ''
    if (text) return text.slice(0, MAX_PROMPT_SUGGESTION_CHARS)
  }
  return null
}
