/** How a Mattermost reply names the agents it addresses, and which posts this daemon's own bots authored. */
import {
  mattermostTextAddressesAnyone,
  resolveMattermostMentionedAgents,
  type AgentMentionIdentity
} from '@agentconnect.md/message'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import type { Integration } from '../../agents/agent-schema.js'
import type { Pending } from '../../daemon/turn-types.js'
import { formatErr } from '../../daemon/text.js'
import type { SendIdentity } from '../../mcp/ops/context.js'
import { configuredBotSelfId, platformIntegrationConfig } from '../integration-config.js'
import type { MattermostConnection } from './connection.js'
import { mattermostExternalAppId } from './module.js'

/** What the routing reads from the daemon; nothing here is Mattermost's own. */
export interface MattermostResponseHost {
  agents(): Iterable<{ id: string; integrations: readonly Integration[] }>
  agent(agentId: string): { integrations: readonly Integration[] } | undefined
  connections(): Iterable<MattermostConnection>
  connFor(integrationId: string): MattermostConnection | undefined
  /** The bot user id a live connection reported for the integration. */
  liveBotUserId(integrationId: string): string | undefined
  agentPostIdentity(agentId: string): SendIdentity
  orgForAgent(agentId: string): string | undefined
  mentionDirectory(orgId: string, platform: string, channel: string): readonly AgentMentionIdentity[]
  debug(message: string): void
}

export class MattermostResponseRouting {
  /** A Mattermost bot has no app id of its own, so an agent's author is verified by the bot user that posted. */
  readonly authorIsBotUser = true

  constructor(private readonly host: MattermostResponseHost) {}

  /** Whether `senderId` is one of this daemon's own Mattermost bots, on `appId`'s server when one is given. */
  isLocalBot(senderId: string, appId?: string): boolean {
    for (const conn of this.host.connections()) {
      if (!!conn.botUserId && senderId === conn.botUserId && (!appId || conn.workspaceId() === appId)) return true
    }
    for (const agent of this.host.agents()) {
      for (const int of agent.integrations) {
        if (int.platform !== MATTERMOST_PLATFORM) continue
        const cfg = platformIntegrationConfig(MATTERMOST_PLATFORM, int)
        if (!cfg) continue
        if (configuredBotSelfId(int) !== senderId && this.host.liveBotUserId(int.id) !== senderId) continue
        if (!appId || mattermostExternalAppId(cfg.serverUrl) === appId) return true
      }
    }
    return false
  }

  sendIdentity(p: Pending, deliveryState: 'streaming' | 'final'): SendIdentity {
    const base = this.host.agentPostIdentity(p.plan.agentId)
    if (!p.reply.responseId) return base
    const prepared = p.reply.finalRouting
    const mentionedAgentIds = deliveryState === 'final' ? (prepared?.mentionedAgentIds ?? []) : []
    return {
      ...base,
      response: {
        responseId: p.reply.responseId,
        deliveryState,
        hopCount: p.plan.sourceHopCount ?? 0,
        mentionedAgentIds
      }
    }
  }

  private serverAppIdForTurn(p: Pending): string | undefined {
    const conn = p.egress ?? p.conn
    const workspaceId = (conn as { workspaceId?(): string } | undefined)?.workspaceId?.()
    if (workspaceId) return workspaceId
    if (!p.plan.integrationId) return undefined
    const boundConn = this.host.connFor(p.plan.integrationId)
    if (boundConn) return boundConn.workspaceId()
    const int = this.host
      .agent(p.plan.agentId)
      ?.integrations.find((item) => item.id === p.plan.integrationId && item.platform === MATTERMOST_PLATFORM)
    const cfg = int ? platformIntegrationConfig(MATTERMOST_PLATFORM, int) : undefined
    return cfg?.serverUrl ? mattermostExternalAppId(cfg.serverUrl) : undefined
  }

  private mentionHandles(entry: AgentMentionIdentity, turnAppId?: string): string[] {
    const handles: string[] = []
    const pushHandle = (raw?: string) => {
      const handle = raw?.trim().replace(/^@+/, '').trim()
      if (handle && !handles.includes(handle)) handles.push(handle)
    }
    pushHandle(entry.botUsername)
    const entryIntegrationId = (entry as { integrationId?: string }).integrationId
    for (const agent of this.host.agents()) {
      for (const int of agent.integrations) {
        if (int.platform !== MATTERMOST_PLATFORM) continue
        const conn = this.host.connFor(int.id)
        const cfg = platformIntegrationConfig(MATTERMOST_PLATFORM, int)
        const intAppId = conn?.workspaceId() ?? (cfg?.serverUrl ? mattermostExternalAppId(cfg.serverUrl) : undefined)
        if (turnAppId && intAppId && intAppId !== turnAppId) continue
        const intBotUserId = conn?.botUserId || this.host.liveBotUserId(int.id) || configuredBotSelfId(int)
        const matchesEntry =
          (entryIntegrationId !== undefined && int.id === entryIntegrationId) ||
          (entry.botUserId !== undefined && intBotUserId === entry.botUserId) ||
          agent.id === entry.agentId
        if (!matchesEntry) continue
        pushHandle(conn?.botUsername?.trim() || cfg?.botUsername?.trim())
      }
    }
    pushHandle(entry.name)
    return handles
  }

  resolveRouting(
    p: Pending,
    directory: readonly AgentMentionIdentity[]
  ): { mentionedAgentIds: string[]; addressedAnyone: boolean } {
    const turnAppId = this.serverAppIdForTurn(p)
    const expandedDir: AgentMentionIdentity[] = []
    for (const entry of directory) {
      const handles = this.mentionHandles(entry, turnAppId)
      if (handles.length === 0) {
        expandedDir.push(entry)
        continue
      }
      for (const handle of handles) {
        expandedDir.push({ ...entry, botUsername: handle })
      }
    }
    const mentionedAgentIds = resolveMattermostMentionedAgents(p.reply.text, expandedDir).filter(
      (id) => id !== p.plan.agentId
    )
    return {
      mentionedAgentIds,
      addressedAnyone: mattermostTextAddressesAnyone(p.reply.text)
    }
  }

  prepareResponseClosure(p: Pending): void {
    const conn = p.egress ?? p.conn
    if (!conn || !p.reply.responseId) return
    const orgId = this.host.orgForAgent(p.plan.agentId)
    const directory = orgId ? this.host.mentionDirectory(orgId, p.plan.platform, p.plan.channel) : []
    const hasPeers = directory.some((entry) => entry.agentId !== p.plan.agentId)
    const ownEntry = directory.find((entry) => entry.agentId === p.plan.agentId)
    const ownInt = p.plan.integrationId
      ? this.host.agent(p.plan.agentId)?.integrations.find((i) => i.id === p.plan.integrationId)
      : undefined
    const ownBotUserId =
      (p.plan.integrationId ? this.host.connFor(p.plan.integrationId)?.botUserId : undefined) ||
      (p.plan.integrationId ? this.host.liveBotUserId(p.plan.integrationId) : undefined) ||
      (ownInt ? configuredBotSelfId(ownInt) : undefined) ||
      ownEntry?.botUserId
    const peerSharesBot = Boolean(
      ownBotUserId && directory.some((entry) => entry.agentId !== p.plan.agentId && entry.botUserId === ownBotUserId)
    )
    const { mentionedAgentIds, addressedAnyone } = this.resolveRouting(p, directory)
    p.reply.finalRouting = {
      mentionedAgentIds,
      addressedAnyone,
      hasPeers,
      peerSharesBot
    }
  }

  async closeResponse(p: Pending): Promise<void> {
    const conn = (p.egress ?? p.conn) as unknown as MattermostConnection | undefined
    if (!conn || !p.reply.responseId) return
    if (p.reply.finalStamped !== undefined && p.reply.finalStamped === p.reply.lastResponse?.ts) return
    const prepared = p.reply.finalRouting
    if (prepared && !prepared.hasPeers) return
    const body = p.reply.lastResponse
    if (!body) return
    const orgId = this.host.orgForAgent(p.plan.agentId)
    const mentionDir = orgId ? this.host.mentionDirectory(orgId, p.plan.platform, p.plan.channel) : []
    const fallback = prepared ? undefined : this.resolveRouting(p, mentionDir)
    const recipients = prepared?.mentionedAgentIds ?? fallback!.mentionedAgentIds
    const addressedAnyone = prepared?.addressedAnyone ?? fallback!.addressedAnyone
    p.reply.closedRouting = { mentionedAgentIds: recipients, addressedAnyone }
    if (typeof conn.patchPost !== 'function') return
    await conn
      .patchPost(body.ts, body.text, {
        identity: {
          ...this.host.agentPostIdentity(p.plan.agentId),
          response: {
            responseId: p.reply.responseId,
            deliveryState: 'final',
            hopCount: p.plan.sourceHopCount ?? 0,
            mentionedAgentIds: recipients,
            ...(addressedAnyone ? { addressedAnyone: true } : {})
          }
        }
      })
      .catch((err) => this.host.debug(`mattermost: closeResponse patch failed (${formatErr(err)})`))
  }
}
