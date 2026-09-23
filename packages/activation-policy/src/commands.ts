// In-conversation control commands: `!word` (Slack) or `/word` (Telegram/Discord), optional `@botname`, then the argument.

export type AgentCommand =
  /** `!stop` — interrupt the in-flight turn and mute the thread until an explicit @-mention. */
  | { kind: 'stop' }
  /** `!cancel` — interrupt the in-flight turn but leave the session live (no mute). */
  | { kind: 'cancel' }
  /** `!resume` — reset a latched loop guard and clear a standing thread mute. */
  | { kind: 'resume' }
  /** `!new` — start over here (a successor session in append mode, a context reset otherwise). */
  | { kind: 'new' }
  /** `!queue <text>` — buffer <text> and dispatch it once the agent goes idle. */
  | { kind: 'queue'; text: string }
  /** `/status` — reply with the session's current model / context / tokens. */
  | { kind: 'status' }
  /** `/fast on|off` — toggle fast mode; `enable` is null for a bare or unrecognized argument. */
  | { kind: 'fast'; enable: boolean | null }
  /** `/models [name|number]` (or `/model`) — pick the model; null lists the choices. */
  | { kind: 'model'; value: string | null }
  /** `/effort [level|number]` — pick the reasoning-effort level; null lists the choices. */
  | { kind: 'effort'; value: string | null }
  /** `/permission [mode|number]` (or `/permissions`, `/perm`) — pick the permission mode. */
  | { kind: 'permission'; value: string | null }

/** Accepted command prefixes (Slack uses `!`; `/` is the Telegram/Discord surface). */
export const COMMAND_PREFIXES = ['!', '/'] as const

export const STOP_WORDS: ReadonlySet<string> = new Set(['stop'])
export const CANCEL_WORDS: ReadonlySet<string> = new Set(['cancel'])
export const RESUME_WORDS: ReadonlySet<string> = new Set(['resume'])
export const NEW_WORDS: ReadonlySet<string> = new Set(['new'])
export const QUEUE_WORDS: ReadonlySet<string> = new Set(['queue'])
export const STATUS_WORDS: ReadonlySet<string> = new Set(['status'])
export const FAST_WORDS: ReadonlySet<string> = new Set(['fast'])
export const MODEL_WORDS: ReadonlySet<string> = new Set(['model', 'models'])
export const EFFORT_WORDS: ReadonlySet<string> = new Set(['effort'])
export const PERMISSION_WORDS: ReadonlySet<string> = new Set(['permission', 'permissions', 'perm'])

/** A leading control command, or null; the prefix must be the first non-space character, then a known word. */
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
  if (NEW_WORDS.has(word)) return { kind: 'new' }
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
