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

/** The slot an internal pass parks its ACP session in. One live session per slot, so registering
 *  the next one retires the slot's previous session and the registry cannot grow with uptime. */
export const internalPassSlot = {
  /** Keyed by the distillation cache key (agent + memory scope), whose session is cached and reused. */
  distill: (cacheKey: string) => `distill:${cacheKey}`,
  commit: (agentId: string) => `commit:${agentId}`,
  dream: (agentId: string) => `dream:${agentId}`
}

/** The ACP sessions the daemon opens for its OWN passes — distillation, the commit-message wand, a
 *  dream — over a throwaway temp dir. Their advertisement is missing the agent's project skills, and
 *  the two that run on the agent's own warm host are indistinguishable there by session ownership.
 *  Register SYNCHRONOUSLY in the continuation right after `newSession` resolves: the adapter
 *  advertises on a timer, so a registration behind one more await loses the race (#1310 review). */
export class InternalPassSessions {
  private readonly bySlot = new Map<string, string>()
  private readonly slotOf = new Map<string, string>()

  add(slot: string, sessionKey: string): void {
    const prior = this.bySlot.get(slot)
    if (prior !== undefined && prior !== sessionKey) this.slotOf.delete(prior)
    this.bySlot.set(slot, sessionKey)
    this.slotOf.set(sessionKey, slot)
  }

  has(sessionKey: string): boolean {
    return this.slotOf.has(sessionKey)
  }

  delete(sessionKey: string): void {
    const slot = this.slotOf.get(sessionKey)
    if (slot === undefined) return
    this.slotOf.delete(sessionKey)
    if (this.bySlot.get(slot) === sessionKey) this.bySlot.delete(slot)
  }

  get size(): number {
    return this.slotOf.size
  }
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
