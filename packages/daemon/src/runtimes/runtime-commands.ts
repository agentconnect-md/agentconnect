// The last slash-command list each agent's runtime advertised over ACP `available_commands_update`
// (agentclientprotocol.com/protocol/v1/slash-commands) — the runtime's own answer to what it can be
// asked to run, including for a cluster agent whose workspace no local scan can reach.

import { isSkillCommand, type RuntimeCommand, type RuntimeCommandsList } from '@agentconnect.md/protocol'

// Names/descriptions are workspace-controlled (a repo's SKILL.md), and the reply rides a control
// frame the receiver rejects over 256 KiB — bound both.
const MAX_COMMANDS = 512
const MAX_NAME_CHARS = 256
const MAX_DESCRIPTION_CHARS = 512
const MAX_HINT_CHARS = 256
const MAX_TOTAL_BYTES = 200 * 1024

export interface AdvertisedCommands {
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
    const rawDescription = typeof row.description === 'string' ? row.description : ''
    // Classify from the RAW description — the claude skill marker is its SUFFIX, which both the
    // display cap and the strip below would otherwise destroy before the bit is derived.
    const skill = isSkillCommand({ name, description: rawDescription })
    // The scope marker is adapter bookkeeping, not prose: once the bit is derived, showing
    // "… (project)" to a user is a leak, so it never enters the stored description.
    const command: RuntimeCommand = {
      name,
      description: text(rawDescription.replace(/\s*\((?:user|project)\)\s*$/, ''), MAX_DESCRIPTION_CHARS) ?? '',
      hint: input && typeof input === 'object' ? text(input.hint, MAX_HINT_CHARS) : null,
      skill
    }
    bytes += Buffer.byteLength(JSON.stringify(command)) + 1
    if (bytes > MAX_TOTAL_BYTES) break
    seen.add(name)
    commands.push(command)
  }
  return commands
}

/** The slot an internal pass parks its ACP session in. One live session per slot, so registering
 *  the next one retires the slot's previous session and the registry cannot grow with uptime.
 *  A pass that DISCARDS its session takes a slot per session instead — it deletes its own entry, so
 *  it needs no retirement, and retiring one press while a concurrent one is still live would re-open
 *  the gap the registry exists to close. */
export const internalPassSlot = {
  /** The distillation session is cached and reused per memory scope, and has no discard site. */
  distill: (cacheKey: string) => `distill:${cacheKey}`,
  /** Two presses on one agent can overlap — the console disables its own button, two tabs do not. */
  commit: (agentId: string, sessionId: string) => `commit:${agentId}:${sessionId}`,
  /** Per agent, not per dream: a dream can fail before the discard in its own finally, and its
   *  dedicated host keeps it out of the gate whether or not this entry is current. */
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

  record(agentId: string, sessionId: string, update: unknown, at: number): AdvertisedCommands | null {
    if (!isAvailableCommandsUpdate(update)) return null
    const entry: AdvertisedCommands = {
      sessionId,
      updatedAt: new Date(at).toISOString(),
      commands: normalizeAvailableCommands(update)
    }
    this.byAgent.set(agentId, entry)
    return entry
  }

  /** Hydrate one agent from the persisted copy — a LIVE advertisement always wins, so this only
   *  fills an absent slot (daemon restart/upgrade must not blind the picker until the next
   *  session happens to start). */
  seed(agentId: string, entry: AdvertisedCommands): void {
    if (!this.byAgent.has(agentId)) this.byAgent.set(agentId, entry)
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
