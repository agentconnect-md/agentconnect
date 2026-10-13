// A place turning external (assistant-mode.md §5.3): every agent's detections and their report to the CP.
import {
  mergePlaceExternalReason,
  placeExternalReasonSticky,
  type IntegrationChannel,
  type PlaceExternalReason,
  type PlaceTrustLevel
} from '@agentconnect.md/protocol'
import type { Integration } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { integrationCore, noteExternalChannel } from '../platforms/integration-config.js'

/** How long the platform's answer on a share is trusted before a post no event triggered asks again. */
export const PLACE_SHARE_TTL_MS = 60_000
const MAX_SHARE_ENTRIES = 512

export interface PlaceTrustDeps {
  /** The live integration, as turns read it. */
  integration: (integrationId: string) => Integration | undefined
  /** Hand a detection to the CP, which stores it and re-pushes the spec. */
  report: (integrationId: string, channel: IntegrationChannel) => void
  now: () => number
  /** The platform's word on whether a conversation is shared now; undefined where the platform reports no share. */
  shareLookup: (integrationId: string) => ((channel: string) => Promise<PlaceExternalReason | null>) | undefined
}

interface ShareAnswer {
  at: number
  reason: Promise<PlaceExternalReason | null>
}

export class PlaceTrust {
  /** Detections replayed on every reconnect: a share until a spec lists it, a guest or an outside member until it is unbound or unlisted. */
  private readonly pending = new Map<string, Map<string, PlaceExternalReason>>()
  private readonly shares = new Map<string, ShareAnswer>()

  constructor(private readonly deps: PlaceTrustDeps) {}

  /** Whether any of the integrations is an agent's, in any mode, so a member join is worth a lookup. */
  watches(integrationIds: readonly string[]): boolean {
    return integrationIds.some((id) => this.deps.integration(id) !== undefined)
  }

  /** A message the platform delivered from a conversation shared with another organization; a 1:1 DM is trusting that person. */
  observe(
    msg: Pick<NormalizedMessage, 'externallyShared' | 'isDm' | 'isGroupDm' | 'channel'>,
    integrationIds: readonly string[]
  ): void {
    if (msg.externallyShared !== true || (msg.isDm && msg.isGroupDm !== true)) return
    this.detected(integrationIds, msg.channel, 'externallyShared')
  }

  /** Before a post no event from the place triggered: external, internal, or `unknown` when the platform could not say; one lookup per place per TTL. */
  async confirm(integrationId: string, channel: string): Promise<PlaceTrustLevel | 'unknown'> {
    const int = this.deps.integration(integrationId)
    if (int && integrationCore(int).externalChannels.includes(channel)) return 'external'
    const lookup = this.deps.shareLookup(integrationId)
    if (!lookup) return 'internal'
    const key = `${integrationId}\u001f${channel}`
    const now = this.deps.now()
    let answer = this.shares.get(key)
    if (!answer || now - answer.at >= PLACE_SHARE_TTL_MS) {
      const fresh: ShareAnswer = { at: now, reason: lookup(channel) }
      answer = fresh
      this.shares.delete(key)
      this.shares.set(key, fresh)
      const oldest = this.shares.size > MAX_SHARE_ENTRIES ? this.shares.keys().next().value : undefined
      if (oldest !== undefined) this.shares.delete(oldest)
      // Registered before any caller awaits, so a share found is the same detection an event's flag makes; a failure is asked again.
      void fresh.reason.then(
        (reason) => {
          if (reason) this.detected([integrationId], channel, reason)
        },
        () => {
          if (this.shares.get(key) === fresh) this.shares.delete(key)
        }
      )
    }
    try {
      return (await answer.reason) ? 'external' : 'internal'
    } catch {
      return 'unknown'
    }
  }

  /** A platform found the place external, for every agent: it reads external at once and the CP records it. */
  detected(integrationIds: readonly string[], channel: string, reason: PlaceExternalReason): void {
    for (const id of integrationIds) {
      const int = this.deps.integration(id)
      if (!int) continue
      const wasExternal = noteExternalChannel(int, channel)
      // An already external place is reported again only to make a share's detection sticky.
      if (wasExternal && !placeExternalReasonSticky(reason)) continue
      const held = this.pending.get(id) ?? new Map<string, PlaceExternalReason>()
      held.set(channel, mergePlaceExternalReason(held.get(channel) ?? null, reason) ?? reason)
      this.pending.set(id, held)
      this.deps.report(id, { id: channel, externalReason: reason })
    }
  }

  /** A CP spec was applied: a held place it misses stays external, a held share it lists is the CP's now, and a newly listed place reads external. */
  specApplied(integrationId: string, next: Integration, added: readonly string[]): void {
    const held = this.pending.get(integrationId)
    if (held) {
      const listed = new Set(integrationCore(next).externalChannels)
      for (const [channel, reason] of [...held]) {
        // The spec names the set, not the reason, so listing a place never confirms a guest or an outside member.
        if (!listed.has(channel)) noteExternalChannel(next, channel)
        else if (!placeExternalReasonSticky(reason)) held.delete(channel)
      }
      if (held.size === 0) this.pending.delete(integrationId)
    }
    const live = this.deps.integration(integrationId)
    // The live integration is replaced only once the push reconciles; until then it must read external too.
    if (live) for (const channel of added) noteExternalChannel(live, channel)
  }

  /** A complete membership listing's rows, carrying what is held: its null lifts a held share, never a guest or an outside member. */
  listed(integrationId: string, rows: readonly IntegrationChannel[]): IntegrationChannel[] {
    const held = this.pending.get(integrationId)
    if (!held) return [...rows]
    const carried = rows.map((row) => {
      const stored = held.get(row.id)
      if (stored === undefined) return row
      const merged = mergePlaceExternalReason(stored, row.externalReason)
      if (merged === null) held.delete(row.id)
      else held.set(row.id, merged)
      return { ...row, externalReason: merged }
    })
    // A member join is seen only in a channel the bot is in, so a held guest the listing lacks is a channel it left.
    const present = new Set(rows.map((row) => row.id))
    for (const [channel, reason] of [...held])
      if (!present.has(channel) && placeExternalReasonSticky(reason)) held.delete(channel)
    if (held.size === 0) this.pending.delete(integrationId)
    return carried
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

  /** The integrations holding detections to replay. */
  heldIntegrations(): string[] {
    return [...this.pending.keys()]
  }

  /** Drop what an unbound integration held, as its cached snapshot is. */
  forget(integrationId: string): void {
    this.pending.delete(integrationId)
  }
}
