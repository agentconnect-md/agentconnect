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
import type { BuiltinMcpSkillName } from '../skills/builtin-skills.js'

export interface SkillInvocation {
  /** The ADVERTISED name — `code-review` on claude, `$code-review` on codex. */
  name: string
  args: string
  /** `mcp`: a built-in system skill the daemon's `readSkill` serves (skill-over-mcp.md §5.1); absent means runtime-advertised. */
  source?: 'mcp'
}

/** The typed prefixes; `!` is the Slack alias (Slack swallows `/`), accepted everywhere like
 *  parseCommand's. Control words never reach this seam — parseCommand intercepts them upstream. */
const PREFIXES = ['/', '!']

/** Match a human turn against the agent's advertised commands, then the session's MCP system skills. `null` ⇒ deliver unchanged. */
export function matchSkillInvocation(
  text: string,
  commands: readonly RuntimeCommand[],
  mcpSkills: readonly BuiltinMcpSkillName[] = []
): SkillInvocation | null {
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
  const args = space === -1 ? '' : body.slice(space + 1).trim()
  if (command) return { name: command.name, args }
  // A runtime-advertised skill of the same name wins above; a system skill is not on disk, so the runtime cannot advertise it.
  const bare = token.startsWith('$') ? token.slice(1) : token
  const mcpSkill = mcpSkills.find((name) => name === bare)
  return mcpSkill ? { name: mcpSkill, args, source: 'mcp' } : null
}

/** The instruction the model sees in place of the raw token; a runtime command keeps its literal `/name` (see module header). */
export function renderSkillInvocation(invocation: SkillInvocation): string {
  if (invocation.source === 'mcp') {
    const suffix = invocation.args ? `: ${invocation.args}` : '.'
    return `Use the "${invocation.name}" system skill by calling the \`readSkill\` tool with \`{"name":"${invocation.name}"}\`, then follow its instructions to handle this request${suffix}`
  }
  return `Run the command /${invocation.name}${invocation.args ? ` ${invocation.args}` : ''}`
}
