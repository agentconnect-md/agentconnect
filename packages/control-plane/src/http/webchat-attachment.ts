// Protocol selection belongs to attachment bootstrap, after the existing conversation authorization.
import { z } from 'zod'
import { API_AHP_V1_FEATURE, AhpSessionUri } from '@agentconnect.md/protocol'
import { AgentId, type OrgId } from '../domain/ids.js'
import type { HttpDeps } from './deps.js'

export const WebchatProtocol = z.enum(['legacy', 'ahp'])
export type WebchatProtocol = z.infer<typeof WebchatProtocol>
const AhpPeer = z.object({ agentId: z.string().uuid(), url: z.string().url(), sessionUri: AhpSessionUri.optional() })
export const WebchatAttachmentDto = z.object({
  protocol: WebchatProtocol,
  ahp: z.object({ url: z.string().url(), sessionUri: AhpSessionUri.optional(), peers: z.array(AhpPeer) }).optional()
})
export type WebchatAttachment = z.infer<typeof WebchatAttachmentDto>

// Whether a daemon can serve Webchat over AHP; the console reads the same answer per agent to pick a protocol.
export function servesAhpWebchat(
  config: Pick<HttpDeps['config'], 'AHP_MODE' | 'PUBLIC_RELAY_URL'>,
  daemon: { capabilities?: { features?: readonly string[] } } | null | undefined
): boolean {
  return (
    config.AHP_MODE === 'on' &&
    !!config.PUBLIC_RELAY_URL &&
    daemon?.capabilities?.features?.includes(API_AHP_V1_FEATURE) === true
  )
}

export async function webchatAttachment(
  deps: Pick<HttpDeps, 'config' | 'repos' | 'placementResolver' | 'daemonConns'>,
  input: {
    orgId: OrgId
    primaryAgentId: string
    conversationId: string
    protocol?: WebchatProtocol
    agentIds?: readonly string[]
  }
): Promise<WebchatAttachment | null> {
  const protocol = input.protocol ?? deps.config.WEBCHAT_PROTOCOL ?? 'legacy'
  // A pinned legacy reconnect remains available even after the deployment switches its new attachments.
  if (protocol === 'legacy') return { protocol }
  // Only the deployment's preference settles for legacy; an AHP client that asked for AHP cannot use a legacy grant.
  const unavailable = input.protocol ? null : ({ protocol: 'legacy' } as const)
  if (deps.config.AHP_MODE !== 'on' || !deps.config.PUBLIC_RELAY_URL) return unavailable
  const base = new URL(deps.config.PUBLIC_RELAY_URL)
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    return null
  base.protocol = base.protocol === 'https:' || base.protocol === 'wss:' ? 'wss:' : 'ws:'
  const roster =
    input.agentIds ??
    (await deps.repos.webchatConversation.participants(input.orgId, input.conversationId)).map(
      (member) => member.agentId
    )
  const agentIds = [...new Set([input.primaryAgentId, ...roster])]
  const peers: z.infer<typeof AhpPeer>[] = []
  for (const id of agentIds) {
    const agent = await deps.repos.agent.get(input.orgId, AgentId(id))
    if (!agent || agent.orgId !== input.orgId) return null
    const daemonId = await deps.placementResolver.dispatchDaemon(agent)
    const daemon = daemonId ? deps.daemonConns.get(daemonId) : undefined
    if (daemon?.state !== 'READY' || !servesAhpWebchat(deps.config, daemon)) return unavailable
    const binding = await deps.repos.ahpSessionBinding?.forConversation(input.orgId, id, input.conversationId)
    const url = new URL(base)
    url.pathname = `${base.pathname.replace(/\/$/, '')}/ahp/agents/${encodeURIComponent(id)}`
    peers.push({ agentId: id, url: url.toString(), ...(binding ? { sessionUri: binding.sessionUri } : {}) })
  }
  const primary = peers[0]!
  return {
    protocol,
    ahp: { url: primary.url, ...(primary.sessionUri ? { sessionUri: primary.sessionUri } : {}), peers }
  }
}
