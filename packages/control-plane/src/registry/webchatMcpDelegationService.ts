/**
 * Live entitlement boundary for the built-in general preset's webchat MCP.
 *
 * All caller-controlled ids are checked against durable conversation ownership,
 * current membership/visibility, the preset relation, and live placement before
 * any invocation assertion is minted.
 */
import { DELEGATED_MCP_ASSERTION_FEATURE } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'
import { canView } from '../http/visibility.js'
import { findTool } from '../http/mcp/tools.js'
import type {
  AgentRepo,
  McpInvocationRecord,
  McpInvocationRepo,
  McpInvocationStatus,
  OrgRepo,
  PresetAgentStore,
  WebchatConversationRepo,
  WebchatMcpDelegationRepo
} from '../persistence/ports.js'
import type { InvocationAssertionCodec } from './invocationAssertion.js'

export const MCP_INVOCATION_ASSERTION_TTL_MS = 30_000
export const WEBCHAT_MCP_DELEGATION_DEFAULT_TTL_MS = 12 * 60 * 60_000

export const DELEGATION_DENIED = Object.freeze({
  kind: 'denied' as const,
  code: 'DELEGATION_DENIED' as const,
  message: 'Delegated MCP invocation is not authorized.',
  status: 403 as const
})

export const INVOCATION_CONFLICT = Object.freeze({
  kind: 'conflict' as const,
  code: 'INVOCATION_CONFLICT' as const,
  message: 'Invocation id is already bound to a different request.',
  status: 409 as const
})

export type DelegationDenialReason =
  | 'conversation_binding'
  | 'session_expired'
  | 'membership_missing'
  | 'agent_not_visible'
  | 'preset_mismatch'
  | 'placement_mismatch'
  | 'daemon_unavailable'
  | 'daemon_feature_missing'
  | 'delegation_inactive'
  | 'delegation_generation'
  | 'delegation_binding'
  | 'method_not_allowed'
  | 'tool_not_allowed'
  | 'invocation_parent_missing'

export interface DelegationReference {
  id: string
  generation: number
  expiresAt: string
}

export interface EstablishDelegationInput {
  conversationId: string
  verifiedUserId: string
  orgId: string
  agentId: string
  daemonId: string
  /** Earlier logical-session ceiling. The service never extends it. */
  sessionExpiresAt?: Date
}

export interface MintInvocationInput {
  authenticatedDaemonId: string
  delegationId: string
  generation: number
  agentId: string
  conversationId: string
  invocationId: string
  requestHash: string
  method: string
  toolName?: string
}

export type MintInvocationResult =
  | { kind: 'minted'; invocationId: string; assertion: string; expiresAt: string }
  | { kind: 'existing'; invocationId: string; status: McpInvocationStatus }
  | typeof INVOCATION_CONFLICT
  | typeof DELEGATION_DENIED

interface EntitlementAgent {
  id: string
  orgId: string
  daemonId: string | null
  createdByUserId: string | null
  visibility: 'org' | 'restricted'
  sharedWith: string[]
}

interface LiveDaemon {
  reachable: boolean
  state: string
  capabilities?: { features?: string[] }
}

export interface WebchatMcpDelegationServiceDeps {
  clock: Pick<Clock, 'now'>
  assertionCodec: Pick<InvocationAssertionCodec, 'mint'>
  conversations: Pick<WebchatConversationRepo, 'findOwner' | 'owns'>
  orgs: Pick<OrgRepo, 'roleOf'>
  agents: Pick<AgentRepo, 'get'>
  presets: Pick<PresetAgentStore, 'get'>
  daemons: { get(daemonId: string): LiveDaemon | undefined }
  delegations: Pick<WebchatMcpDelegationRepo, 'establish' | 'get'>
  invocations: Pick<McpInvocationRepo, 'get' | 'mint'>
  /** Internal metric seam. Values are a closed, non-secret enum only. */
  onDenied?: (reason: DelegationDenialReason) => void
}

interface ResolvedAuthority {
  userId: string
}

export class WebchatMcpDelegationService {
  constructor(private readonly deps: WebchatMcpDelegationServiceDeps) {}

  async establish(input: EstablishDelegationInput): Promise<DelegationReference | null> {
    const now = new Date(this.deps.clock.now())
    const defaultExpiry = new Date(now.getTime() + WEBCHAT_MCP_DELEGATION_DEFAULT_TTL_MS)
    const expiresAt =
      input.sessionExpiresAt && input.sessionExpiresAt.getTime() < defaultExpiry.getTime()
        ? new Date(input.sessionExpiresAt)
        : defaultExpiry
    if (expiresAt.getTime() <= now.getTime()) return this.denyNull('session_expired')

    const authority = await this.resolveAuthority({
      conversationId: input.conversationId,
      expectedUserId: input.verifiedUserId,
      orgId: input.orgId,
      agentId: input.agentId,
      daemonId: input.daemonId
    })
    if (!authority) return null

    const delegation = await this.deps.delegations.establish({
      conversationId: input.conversationId,
      userId: authority.userId,
      orgId: OrgId(input.orgId),
      agentId: AgentId(input.agentId),
      daemonId: DaemonId(input.daemonId),
      now,
      expiresAt
    })
    if (!delegation) return this.denyNull('conversation_binding')
    return {
      id: delegation.id,
      generation: delegation.generation,
      expiresAt: delegation.expiresAt.toISOString()
    }
  }

  async mintInvocation(input: MintInvocationInput): Promise<MintInvocationResult> {
    const normalizedToolName = this.validateCatalog(input)
    if (normalizedToolName === undefined) return DELEGATION_DENIED

    const now = new Date(this.deps.clock.now())
    const delegation = await this.deps.delegations.get(input.delegationId)
    if (!delegation || delegation.revokedAt || delegation.expiresAt.getTime() <= now.getTime()) {
      return this.deny('delegation_inactive')
    }
    if (delegation.generation !== input.generation) return this.deny('delegation_generation')
    if (
      delegation.daemonId !== input.authenticatedDaemonId ||
      delegation.agentId !== input.agentId ||
      delegation.conversationId !== input.conversationId
    ) {
      return this.deny('delegation_binding')
    }

    const authority = await this.resolveAuthority({
      conversationId: delegation.conversationId,
      expectedUserId: delegation.userId,
      orgId: delegation.orgId,
      agentId: delegation.agentId,
      daemonId: delegation.daemonId
    })
    if (!authority) return DELEGATION_DENIED

    const current = await this.deps.invocations.get(input.invocationId)
    if (current) {
      if (!sameInvocationBinding(current, input, normalizedToolName)) return INVOCATION_CONFLICT
      if (current.status !== 'issued') {
        return { kind: 'existing', invocationId: current.id, status: current.status }
      }
    }

    const minted = this.deps.assertionCodec.mint()
    const assertionExpires = new Date(now.getTime() + MCP_INVOCATION_ASSERTION_TTL_MS)
    const result = await this.deps.invocations.mint({
      invocationId: input.invocationId,
      delegationId: input.delegationId,
      assertionHash: minted.persistence.assertionHash,
      requestHash: input.requestHash,
      method: input.method,
      toolName: normalizedToolName,
      assertionExpires,
      now
    })

    switch (result.kind) {
      case 'issued':
        return {
          kind: 'minted',
          invocationId: input.invocationId,
          assertion: minted.plaintext,
          expiresAt: assertionExpires.toISOString()
        }
      case 'existing':
        return {
          kind: 'existing',
          invocationId: result.invocation.id,
          status: result.invocation.status
        }
      case 'conflict':
        return INVOCATION_CONFLICT
      case 'denied':
        return this.deny('invocation_parent_missing')
    }
  }

  private validateCatalog(input: MintInvocationInput): string | null | undefined {
    if (input.method === 'tools/list') {
      if (input.toolName !== undefined) {
        this.deps.onDenied?.('tool_not_allowed')
        return undefined
      }
      return null
    }
    if (input.method !== 'tools/call') {
      this.deps.onDenied?.('method_not_allowed')
      return undefined
    }
    if (!input.toolName || !findTool(input.toolName)) {
      this.deps.onDenied?.('tool_not_allowed')
      return undefined
    }
    return input.toolName
  }

  private async resolveAuthority(input: {
    conversationId: string
    expectedUserId: string
    orgId: string
    agentId: string
    daemonId: string
  }): Promise<ResolvedAuthority | null> {
    const owner = await this.deps.conversations.findOwner(input.conversationId, AgentId(input.agentId))
    if (
      owner === null ||
      owner !== input.expectedUserId ||
      !(await this.deps.conversations.owns({
        conversationId: input.conversationId,
        userId: owner,
        orgId: OrgId(input.orgId),
        agentId: AgentId(input.agentId)
      }))
    ) {
      return this.denyNull('conversation_binding')
    }

    const role = await this.deps.orgs.roleOf(input.orgId, owner)
    if (!role) return this.denyNull('membership_missing')

    const agent = await this.deps.agents.get(AgentId(input.agentId))
    if (
      !agent ||
      agent.id !== input.agentId ||
      agent.orgId !== input.orgId ||
      !canView(agent, { userId: owner, role })
    ) {
      return this.denyNull('agent_not_visible')
    }

    const preset = await this.deps.presets.get(OrgId(input.orgId), 'general')
    if (preset?.agentId !== input.agentId) return this.denyNull('preset_mismatch')
    if (!agent.daemonId || agent.daemonId !== input.daemonId) return this.denyNull('placement_mismatch')

    const daemon = this.deps.daemons.get(input.daemonId)
    if (!daemon?.reachable || daemon.state !== 'READY') return this.denyNull('daemon_unavailable')
    if (!daemon.capabilities?.features?.includes(DELEGATED_MCP_ASSERTION_FEATURE)) {
      return this.denyNull('daemon_feature_missing')
    }
    return { userId: owner }
  }

  private deny(reason: DelegationDenialReason): typeof DELEGATION_DENIED {
    this.deps.onDenied?.(reason)
    return DELEGATION_DENIED
  }

  private denyNull(reason: DelegationDenialReason): null {
    this.deps.onDenied?.(reason)
    return null
  }
}

function sameInvocationBinding(
  current: McpInvocationRecord,
  input: MintInvocationInput,
  toolName: string | null
): boolean {
  return (
    current.id === input.invocationId &&
    current.delegationId === input.delegationId &&
    current.requestHash === input.requestHash &&
    current.method === input.method &&
    current.toolName === toolName
  )
}
