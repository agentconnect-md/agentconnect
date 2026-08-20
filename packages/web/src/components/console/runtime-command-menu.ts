// The `/` skill picker's pure logic: which of the runtime's advertised commands the composer
// offers, how a query narrows them, and what picking one writes into the draft. Kept out of the
// hook so the multi-agent rules — the ones Claude Code and Zed never have to make — are testable
// on their own.
//
// SKILLS only (`isSkillCommand`): the daemon's invocation translation dispatches skills through a
// plain-text instruction, and a harness built-in like `/compact` cannot be dispatched that way —
// offering it would put a dead entry in the menu. This also supersedes the old console-owned-name
// filter: `model` / `effort` / `permission` are built-ins, so the same gate removes them.

import { isSkillCommand } from '@agentconnect.md/protocol'

/** One skill offered in the picker, carrying the agent it belongs to. */
export interface CommandCandidate {
  agentId: string
  agentName: string
  name: string
  description: string
  /** ACP `input.hint` — an argument hint, or null when the command takes none. */
  hint: string | null
}

/** The skills the picker may offer for one agent. */
export function offerableCommands(
  agent: { agentId: string; agentName: string },
  commands: ReadonlyArray<{ name: string; description: string; hint: string | null; skill?: boolean }>
): CommandCandidate[] {
  // The daemon's record-time bit is the truth (it saw the description before the display cap);
  // the heuristic only covers a daemon that predates the field.
  return commands
    .filter((command) => command.skill ?? isSkillCommand(command))
    .map(({ skill: _skill, ...command }) => ({ ...agent, ...command }))
}

/**
 * Narrow the offered commands to a typed query. A prefix match outranks a substring one — typing
 * "re" should reach `review` before `code-review` — and the name is never deduplicated across
 * agents: two participants can both expose `code-review`, and they are different commands.
 */
export function matchCommands(
  candidates: readonly CommandCandidate[],
  query: string,
  limit: number
): CommandCandidate[] {
  const q = query.trim().toLowerCase()
  const scored: Array<{ candidate: CommandCandidate; rank: number }> = []
  for (const candidate of candidates) {
    // codex advertises skills as `$name`; typing `/code` must still reach `$code-review`.
    const name = candidate.name.toLowerCase().replace(/^\$/, '')
    const bare = q.replace(/^\$/, '')
    if (!bare) scored.push({ candidate, rank: 1 })
    else if (name.startsWith(bare)) scored.push({ candidate, rank: 0 })
    else if (name.includes(bare)) scored.push({ candidate, rank: 1 })
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.candidate.name.localeCompare(b.candidate.name))
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

/**
 * What picking `command` writes into the draft: the token is replaced by the ADVERTISED `/name `
 * verbatim (`/$code-review` on codex) with a trailing space for an argument. Nothing else — the
 * owner is addressed STRUCTURALLY (the pick's target rides the send's `mentions[]`), never as
 * `@Name` text: an inline mention would displace the command from the leading position the
 * daemon's translation gate matches on, which is exactly how the first cut of this picker died
 * in review.
 */
export function commandInsertion(input: {
  text: string
  /** Index of the triggering `/`. */
  anchorStart: number
  /** End of the `/token` being replaced. */
  spanEnd: number
  command: Pick<CommandCandidate, 'name'>
}): { text: string; caret: number } {
  const inserted = `/${input.command.name} `
  const head = input.text.slice(0, input.anchorStart)
  const tail = input.text.slice(input.spanEnd)
  return { text: head + inserted + tail, caret: head.length + inserted.length }
}

/** The `/token` a draft leads with (after whitespace and complete @mentions), for validating a
 *  stored pick at send time — the pick only narrows the turn while its token still leads. */
export function leadingCommandToken(text: string): string | null {
  const match = /^\s*(?:@\S+\s+)*\/(\S+)/.exec(text)
  return match ? match[1]! : null
}
