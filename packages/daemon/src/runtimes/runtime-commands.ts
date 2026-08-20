// The last slash-command list each agent's runtime advertised over ACP `available_commands_update`
// (agentclientprotocol.com/protocol/v1/slash-commands) — the runtime's own answer to what it can be
// asked to run, including for a cluster agent whose workspace no local scan can reach.

import type { RuntimeCommand, RuntimeCommandsList } from '@agentconnect.md/protocol'

// Names/descriptions are workspace-controlled (a repo's SKILL.md), and the reply rides a control
// frame the receiver rejects over 256 KiB — bound both.
const MAX_COMMANDS = 512
const MAX_NAME_CHARS = 256
const MAX_DESCRIPTION_CHARS = 512
const MAX_HINT_CHARS = 256
const MAX_TOTAL_BYTES = 200 * 1024

interface AdvertisedCommands {
  sessionId: string
  updatedAt: string
  commands: RuntimeCommand[]
}

/** True for the ACP update this cache is built from. */
export function isAvailableCommandsUpdate(update: unknown): boolean {
  return (update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate === 'available_commands_update'
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, limit) : null
}

/** One advertisement in wire shape: unnamed/duplicate entries dropped, caps enforced, never merged. */
export function normalizeAvailableCommands(update: unknown): RuntimeCommand[] {
  const raw = (update as { availableCommands?: unknown } | undefined)?.availableCommands
  if (!Array.isArray(raw)) return []
  const commands: RuntimeCommand[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const entry of raw) {
    if (commands.length >= MAX_COMMANDS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as { name?: unknown; description?: unknown; input?: unknown }
    const name = text(row.name, MAX_NAME_CHARS)
    if (!name || seen.has(name)) continue
    const input = row.input as { hint?: unknown } | null | undefined
    const command: RuntimeCommand = {
      name,
      description: text(row.description, MAX_DESCRIPTION_CHARS) ?? '',
      hint: input && typeof input === 'object' ? text(input.hint, MAX_HINT_CHARS) : null
    }
    bytes += Buffer.byteLength(JSON.stringify(command)) + 1
    if (bytes > MAX_TOTAL_BYTES) break
    seen.add(name)
    commands.push(command)
  }
  return commands
}

export class RuntimeCommandsCache {
  // Latest-wins per agent, not per session: a session-worktree list still beats none once it ends.
  private readonly byAgent = new Map<string, AdvertisedCommands>()

  record(agentId: string, sessionId: string, update: unknown, at: number): void {
    if (!isAvailableCommandsUpdate(update)) return
    this.byAgent.set(agentId, {
      sessionId,
      updatedAt: new Date(at).toISOString(),
      commands: normalizeAvailableCommands(update)
    })
  }

  get(agentId: string): RuntimeCommandsList {
    const entry = this.byAgent.get(agentId)
    if (!entry) return { reported: false, commands: [] }
    return {
      reported: true,
      updatedAt: entry.updatedAt,
      sessionId: entry.sessionId,
      commands: entry.commands
    }
  }

  forget(agentId: string): void {
    this.byAgent.delete(agentId)
  }
}
