/** Cap for a first-message-derived session title (chars). Runtime-pushed titles are
 *  already short; a raw user message can be long, so the fallback is trimmed. */
const TITLE_MAX_CHARS = 80

/**
 * A short, single-line session title from a raw message body: the first non-empty line,
 * trimmed and capped at TITLE_MAX_CHARS (a trailing `…` marks truncation). Returns undefined
 * for empty/whitespace input.
 *
 * THE fallback-title rule: the console's session list applies it at read time for legacy
 * untitled rows, and the session manager applies it at creation so every new chat session is
 * born with the same title the console would derive — persisted, synced to the CP, and pushed
 * to platform surfaces (Slack thread headers) that a runtime title later overwrites.
 */
export function deriveTitle(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return undefined
  return line.length > TITLE_MAX_CHARS ? line.slice(0, TITLE_MAX_CHARS).trimEnd() + '…' : line
}
