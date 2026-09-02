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

/** How much of a prompt is fingerprinted for the echo test below. Long enough that no real
 *  title reaches it, short enough that a Pending turn does not retain a second prompt copy. */
const PROMPT_ECHO_PREFIX_CHARS = 200
/** Below this the prompt carries too little signal to call a title an echo of it. */
const MIN_PROMPT_ECHO_CHARS = 40

/** The comparison form both sides of an echo test are reduced to. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Bounded fingerprint of the text blocks one turn actually sent, for {@link isPromptEchoTitle}. */
export function promptEchoPrefix(texts: readonly string[]): string {
  return collapse(texts.join(' ')).slice(0, PROMPT_ECHO_PREFIX_CHARS)
}

/**
 * True when a runtime-pushed title is only this turn's prompt read back. codex-acp auto-titles an
 * untitled session from its raw prompt text — every text block joined, whitespace collapsed, no
 * length bound — so a session it re-titles after `session/load` (which carries no leading
 * standing-context block) surfaces the caller's whole message as the title. Prefix, not equality:
 * the echo is the WHOLE prompt while the fingerprint is bounded.
 */
export function isPromptEchoTitle(title: string, promptPrefix: string): boolean {
  if (promptPrefix.length < MIN_PROMPT_ECHO_CHARS) return false
  return collapse(title).startsWith(promptPrefix)
}

/** A runtime-pushed title reduced to the one-line, {@link TITLE_MAX_CHARS} shape every other title
 *  source already produces; `undefined` when the push carries no title text at all. */
export function clampRuntimeTitle(title: string): string | undefined {
  const line = collapse(title)
  if (!line) return undefined
  const chars = [...line]
  return chars.length > TITLE_MAX_CHARS
    ? `${chars
        .slice(0, TITLE_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`
    : line
}
