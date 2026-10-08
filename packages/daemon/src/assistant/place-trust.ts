// A place turning external (assistant-mode.md §5.3): detections, their report to the CP, and the downgrade transition.
import {
  mergePlaceExternalReason,
  placeExternalReasonSticky,
  type IntegrationChannel,
  type PlaceExternalReason
} from '@agentconnect.md/protocol'
import type { Integration } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { integrationCore, noteExternalChannel } from '../platforms/integration-config.js'

export interface PlaceTrustDeps {
  /** The live integration, as turns read it. */
  integration: (integrationId: string) => Integration | undefined
  /** Whether an agent in assistant mode owns the integration; nothing happens for any other agent. */
  assistantOwned: (integrationId: string) => boolean
  /** Hand a detection to the CP, which stores it and re-pushes the spec. */
  report: (integrationId: string, channel: IntegrationChannel) => void
  /** Cut the in-flight turn of every session posting into the place. */
  interrupt: (integrationId: string, channel: string) => Promise<void>
  warn: (message: string) => void
}

export class PlaceTrust {
  /** Detections the CP's spec has not confirmed yet, by integration then conversation: replayed on reconnect, held on every spec. */
  private readonly pending = new Map<string, Map<string, PlaceExternalReason>>()

  constructor(private readonly deps: PlaceTrustDeps) {}

  /** Whether any of the integrations is owned by an agent in assistant mode, so a member join is worth a lookup. */
  watches(integrationIds: readonly string[]): boolean {
    return integrationIds.some((id) => this.deps.assistantOwned(id))
  }

  /** A message the platform delivered from a conversation shared with another organization; a 1:1 DM is trusting that person. */
  observe(
    msg: Pick<NormalizedMessage, 'externallyShared' | 'isDm' | 'isGroupDm' | 'channel'>,
    integrationIds: readonly string[]
  ): void {
    if (msg.externallyShared !== true || (msg.isDm && msg.isGroupDm !== true)) return
    this.detected(integrationIds, msg.channel, 'externallyShared')
  }

  /** A platform found the place external: it reads external at once, the CP records it, and an internal place is downgraded. */
  detected(integrationIds: readonly string[], channel: string, reason: PlaceExternalReason): void {
    for (const id of integrationIds) {
      if (!this.deps.assistantOwned(id)) continue
      const int = this.deps.integration(id)
      if (!int) continue
      const wasExternal = noteExternalChannel(int, channel)
      // An already external place is reported again only to make a share's detection sticky.
      if (wasExternal && !placeExternalReasonSticky(reason)) continue
      const held = this.pending.get(id) ?? new Map<string, PlaceExternalReason>()
      held.set(channel, mergePlaceExternalReason(held.get(channel) ?? null, reason) ?? reason)
      this.pending.set(id, held)
      this.deps.report(id, { id: channel, externalReason: reason })
      if (!wasExternal) void this.downgrade(id, channel)
    }
  }

  /** A CP spec was applied: a place it lists is confirmed, one it misses yet holds stays external, and a newly listed one is downgraded. */
  specApplied(integrationId: string, next: Integration, added: readonly string[]): void {
    const held = this.pending.get(integrationId)
    if (held) {
      const listed = new Set(integrationCore(next).externalChannels)
      for (const channel of [...held.keys()]) {
        if (listed.has(channel)) held.delete(channel)
        else noteExternalChannel(next, channel)
      }
      if (held.size === 0) this.pending.delete(integrationId)
    }
    if (added.length === 0 || !this.deps.assistantOwned(integrationId)) return
    const live = this.deps.integration(integrationId)
    for (const channel of added) {
      // The live integration is replaced only once the push reconciles; until then it must read external too.
      if (live) noteExternalChannel(live, channel)
      void this.downgrade(integrationId, channel)
    }
  }

  /** A membership listing's rows, carrying what is held: its null lifts a held share, never a guest or an outside member. */
  listed(integrationId: string, rows: readonly IntegrationChannel[]): IntegrationChannel[] {
    const held = this.pending.get(integrationId)
    if (!held) return [...rows]
    return rows.map((row) => {
      const stored = held.get(row.id)
      if (stored === undefined) return row
      const merged = mergePlaceExternalReason(stored, row.externalReason)
      if (merged === null) held.delete(row.id)
      else held.set(row.id, merged)
      return { ...row, externalReason: merged }
    })
  }

  /** What a reconnect replays: the cached rows with what is held, plus a row for each held place the cache never saw. */
  replayRows(integrationId: string, rows: readonly IntegrationChannel[]): IntegrationChannel[] {
    const held = this.pending.get(integrationId)
    if (!held) return [...rows]
    const replayed = rows.map((row) => {
      const reason = held.get(row.id)
      return reason ? { ...row, externalReason: reason } : row
    })
    const known = new Set(rows.map((row) => row.id))
    for (const [channel, reason] of held)
      if (!known.has(channel)) replayed.push({ id: channel, externalReason: reason })
    return replayed
  }

  /** The integrations holding detections the CP has not confirmed. */
  heldIntegrations(): string[] {
    return [...this.pending.keys()]
  }

  /** Drop what an unbound integration held, as its cached snapshot is. */
  forget(integrationId: string): void {
    this.pending.delete(integrationId)
  }

  // The transition changes the output path, not the context: only the in-flight turn is cut, nothing is retired.
  private async downgrade(integrationId: string, channel: string): Promise<void> {
    try {
      await this.deps.interrupt(integrationId, channel)
    } catch (err) {
      this.deps.warn(`assistant: interrupting the turn in a place turned external failed: ${(err as Error).message}`)
    }
  }
}
