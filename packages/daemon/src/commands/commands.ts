/**
 * In-conversation control commands.
 *
 * Some user messages are meant to control the *running* agent (or query its state)
 * rather than be fed to it as a prompt — e.g. interrupt the current turn, buffer a
 * message until the agent is idle, or ask for the session status. They are detected
 * at the edge (daemon) before routing and never reach the agent or the transcript.
 * `!resume` is also the explicit recovery control for a durable loop guard.
 *
 * Prefixes: Slack reserves `/xxx` for its own slash commands (the bot never
 * receives them), so the Slack-facing alias is `!`. `/` is parsed too so the same
 * vocabulary works on platforms where bots *do* receive slash commands (Telegram,
 * Discord) — there `/status`, `/stop`, `/cancel`, `/resume`, `/fast`, `/queue` are the user's
 * primary control surface (Telegram has no persistent status bar). The command word
 * must follow the prefix immediately (no space).
 *
 * GROUP ADDRESSING: in a Telegram group a command is delivered as `/stop@botname`,
 * so an optional `@botname` suffix directly after the command word is tolerated and
 * stripped — it belongs to the platform, not the command's argument.
 */

export type AgentCommand =
  /** `!stop` — interrupt the agent's in-flight turn for this session AND mute the
   *  thread: the agent ignores follow-ups until explicitly @-mentioned. */
  | { kind: 'stop' }
  /** `!cancel` — interrupt the in-flight turn but leave the session LIVE (no mute):
   *  follow-up messages still dispatch. The lighter-weight "just stop this turn". */
  | { kind: 'cancel' }
  /** `!resume` — explicitly reset a latched conversation loop guard (and clear a
   *  standing thread mute). Purged loop messages are never replayed. */
  | { kind: 'resume' }
  /** `!queue <text>` — buffer <text> and dispatch it once the agent goes idle. */
  | { kind: 'queue'; text: string }
  /** `/status` — reply with the session's current model / context / tokens (the
   *  on-demand replacement for the platform status bar on Telegram). */
  | { kind: 'status' }
  /** `/fast on|off` — toggle the session's fast mode. `enable` is null for a bare
   *  `/fast` (or an unrecognized argument) so the handler can print usage. */
  | { kind: 'fast'; enable: boolean | null }
  /** `/models [name|number]` — pick the session's model. `value` is null for a bare
   *  `/models` (list the choices); otherwise the chosen model (by id, substring, or the
   *  1-based index from the list). `/model` is accepted too. */
  | { kind: 'model'; value: string | null }
  /** `/effort [level|number]` — pick the session's reasoning-effort level (list on a
   *  bare `/effort`). */
  | { kind: 'effort'; value: string | null }
  /** `/permission [mode|number]` — pick the session's permission/approval mode (list on
   *  a bare `/permission`). `/permissions` and `/perm` are accepted too. */
  | { kind: 'permission'; value: string | null }

/** Accepted command prefixes (Slack uses `!`; `/` is the Telegram/Discord surface). */
export const COMMAND_PREFIXES = ['!', '/'] as const

const STOP_WORDS = new Set(['stop'])
const CANCEL_WORDS = new Set(['cancel'])
const RESUME_WORDS = new Set(['resume'])
const QUEUE_WORDS = new Set(['queue'])
const STATUS_WORDS = new Set(['status'])
const FAST_WORDS = new Set(['fast'])
const MODEL_WORDS = new Set(['model', 'models'])
const EFFORT_WORDS = new Set(['effort'])
const PERMISSION_WORDS = new Set(['permission', 'permissions', 'perm'])

/**
 * Parse a leading control command from a message's text. Returns `null` when the
 * text is not a recognized command (so it flows to the agent unchanged). The
 * prefix must be the first non-whitespace character and be followed immediately by
 * a known command word, so ordinary text like `hello!` or `! note` is never a
 * command. An optional `@botname` right after the word (Telegram group addressing)
 * is stripped before the argument is read.
 */
export function parseCommand(raw: string): AgentCommand | null {
  const text = raw.trimStart()
  const prefix = COMMAND_PREFIXES.find((p) => text.startsWith(p))
  if (!prefix) return null
  const m = /^([a-zA-Z]+)(?:@[A-Za-z0-9_]+)?([\s\S]*)$/.exec(text.slice(prefix.length))
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const arg = (m[2] ?? '').trim()
  if (STOP_WORDS.has(word)) return { kind: 'stop' }
  if (CANCEL_WORDS.has(word)) return { kind: 'cancel' }
  if (RESUME_WORDS.has(word)) return { kind: 'resume' }
  if (QUEUE_WORDS.has(word)) return { kind: 'queue', text: arg }
  if (STATUS_WORDS.has(word)) return { kind: 'status' }
  if (FAST_WORDS.has(word)) {
    const a = arg.toLowerCase()
    return { kind: 'fast', enable: a === 'on' ? true : a === 'off' ? false : null }
  }
  if (MODEL_WORDS.has(word)) return { kind: 'model', value: arg || null }
  if (EFFORT_WORDS.has(word)) return { kind: 'effort', value: arg || null }
  if (PERMISSION_WORDS.has(word)) return { kind: 'permission', value: arg || null }
  return null
}
