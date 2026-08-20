// Turn a typed `/skill args` (or the Slack alias `!skill args`) into an instruction the runtime
// reliably acts on. Delivering the literal token does NOT invoke it: the daemon's `[sender]` prompt
// envelope displaces it from the position each adapter's command detection requires — measured
// 2026-08-20 against claude-agent-acp 0.70.0 (command must be the LAST text block, at offset 0) and
// codex-acp (single-block `prompt[0]`, or its `$name` token expanded anywhere inline). The one
// shape that survives the envelope on BOTH is a plain-text instruction naming the advertised
// command: Claude model-dispatches the named skill; codex core expands the `$name` inline.
//
// Only SKILLS translate (`isSkillCommand`) — a harness built-in like `/compact` cannot be
// dispatched by prose, so translating it would replace a no-op with a misfire. Anything that does
// not match the agent's advertised table verbatim passes through untouched, so `/Users/pc/x is
// broken` never changes.
import { isSkillCommand, type RuntimeCommand } from '@agentconnect.md/protocol'

export interface SkillInvocation {
  /** The ADVERTISED name — `code-review` on claude, `$code-review` on codex. */
  name: string
  args: string
}

/** The typed prefixes; `!` is the Slack alias (Slack swallows `/`), accepted everywhere like
 *  parseCommand's. Control words never reach this seam — parseCommand intercepts them upstream. */
const PREFIXES = ['/', '!']

/** Match a human turn against the agent's advertised commands. `null` ⇒ deliver unchanged. */
export function matchSkillInvocation(text: string, commands: readonly RuntimeCommand[]): SkillInvocation | null {
  const trimmed = text.trimStart()
  if (!PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null
  const body = trimmed.slice(1)
  const space = body.search(/\s/)
  const token = (space === -1 ? body : body.slice(0, space)).toLowerCase()
  if (!token) return null
  // Skills first, so a same-named built-in (codex's `review` vs a `$review` skill) cannot shadow
  // the one entry that is actually invocable. Case-insensitive like codex's own parse; the `skill`
  // bit is record-time truth, with the heuristic only as the pre-field fallback.
  const skills = commands.filter((entry) => entry.skill ?? isSkillCommand(entry))
  const command = skills.find((entry) => {
    const name = entry.name.toLowerCase()
    return name === token || name === `$${token}`
  })
  if (!command) return null
  return { name: command.name, args: space === -1 ? '' : body.slice(space + 1).trim() }
}

/** The instruction the model sees in place of the raw token. Template validated by probe on both
 *  runtimes (see module header); keep the literal `/name` — codex's inline expansion needs the
 *  advertised token present, and Claude's dispatch is anchored by it. */
export function renderSkillInvocation(invocation: SkillInvocation): string {
  return `Run the command /${invocation.name}${invocation.args ? ` ${invocation.args}` : ''}`
}
