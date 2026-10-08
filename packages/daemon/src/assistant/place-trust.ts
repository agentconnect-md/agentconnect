// A place turning external (assistant-mode.md §5.3): detections, their report to the CP, and the downgrade transition.
import { placeExternalReasonSticky, type IntegrationChannel, type PlaceExternalReason } from '@agentconnect.md/protocol'
import type { Integration } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { noteExternalChannel } from '../platforms/integration-config.js'

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
      this.deps.report(id, { id: channel, externalReason: reason })
      if (!wasExternal) void this.downgrade(id, channel)
    }
  }

  /** The CP's spec newly lists these places external, whichever edge detected them. */
  specTurnedExternal(integrationId: string, channels: readonly string[]): void {
    if (!this.deps.assistantOwned(integrationId)) return
    const int = this.deps.integration(integrationId)
    for (const channel of channels) {
      // The live integration is replaced only once the push reconciles; until then it must read external too.
      if (int) noteExternalChannel(int, channel)
      void this.downgrade(integrationId, channel)
    }
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
