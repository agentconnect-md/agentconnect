/**
 * Live entitlement boundary for the built-in general preset's webchat MCP.
 *
 * All caller-controlled ids are checked against durable conversation ownership,
 * current membership/visibility, the preset relation, and live placement before
 * any invocation assertion is minted.
 */
import {
  DELEGATED_MCP_ASSERTION_FEATURE,
  type McpInvocationMint,
  type WebchatMcpDelegationReference
} from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'
import { canView } from '../domain/visibility.js'
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
  | 'delegation_expiry'
  | 'delegation_inactive'
  | 'delegation_generation'
  | 'delegation_binding'
  | 'method_not_allowed'
  | 'tool_not_allowed'
  | 'invocation_parent_missing'

export type DelegationReference = WebchatMcpDelegationReference

export interface EstablishDelegationInput {
  conversationId: string
  verifiedUserId: string
  orgId: string
  agentId: string
  daemonId: string
  /** Earlier logical-session ceiling. The service never extends it. */
  sessionExpiresAt?: Date
}

export type MintInvocationInput = McpInvocationMint & {
  authenticatedDaemonId: string
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
  isCuratedTool(toolName: string): boolean
  /** Internal metric seam. Values are a closed, non-secret enum only. */
  onDenied?: (reason: DelegationDenialReason) => void
}

interface ResolvedAuthority {
  userId: string
}

export class WebchatMcpDelegationService {
  constructor(private readonly deps: WebchatMcpDelegationServiceDeps) {}

  async establish(input: EstablishDelegationInput): Promise<DelegationReference | null> {
    const nowMs = this.deps.clock.now()
    const defaultExpiryMs = safeAddTimestamp(nowMs, WEBCHAT_MCP_DELEGATION_DEFAULT_TTL_MS)
    if (defaultExpiryMs === null) return this.denyNull('session_expired')
    const sessionExpiryMs = input.sessionExpiresAt?.getTime()
    if (sessionExpiryMs !== undefined && !isValidTimestamp(sessionExpiryMs)) {
      return this.denyNull('session_expired')
    }
    const expiresAtMs =
      sessionExpiryMs !== undefined && sessionExpiryMs < defaultExpiryMs ? sessionExpiryMs : defaultExpiryMs
    if (expiresAtMs <= nowMs) return this.denyNull('session_expired')
    const now = new Date(nowMs)
    const expiresAt = new Date(expiresAtMs)

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
    const checkedAt = this.deps.clock.now()
    const returnedExpiry = delegation.expiresAt.getTime()
    if (
      !isValidTimestamp(checkedAt) ||
      !isValidTimestamp(returnedExpiry) ||
      delegation.revokedAt !== null ||
      returnedExpiry <= checkedAt ||
      returnedExpiry > expiresAtMs ||
      !Number.isInteger(delegation.generation) ||
      delegation.generation <= 0 ||
      delegation.conversationId !== input.conversationId ||
      delegation.userId !== authority.userId ||
      delegation.orgId !== input.orgId ||
      delegation.agentId !== input.agentId ||
      delegation.daemonId !== input.daemonId
    ) {
      return this.denyNull('delegation_expiry')
    }
    return {
      id: delegation.id,
      generation: delegation.generation,
      expiresAt: delegation.expiresAt.toISOString()
    }
  }

  async mintInvocation(input: MintInvocationInput): Promise<MintInvocationResult> {
    const normalizedToolName = this.validateCatalog(input)
    if (normalizedToolName === undefined) return DELEGATION_DENIED

    const checkedAt = this.deps.clock.now()
    if (!isValidTimestamp(checkedAt)) return this.deny('delegation_inactive')
    const delegation = await this.deps.delegations.get(input.delegationId)
    if (
      !delegation ||
      delegation.revokedAt ||
      !isValidTimestamp(delegation.expiresAt.getTime()) ||
      delegation.expiresAt.getTime() <= checkedAt
    ) {
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
      const classified = this.classifyExisting(current, input, normalizedToolName)
      if (classified) return classified
    }

    const mintedAtMs = this.deps.clock.now()
    const assertionExpiresMs = safeAddTimestamp(mintedAtMs, MCP_INVOCATION_ASSERTION_TTL_MS)
    if (assertionExpiresMs === null) return this.deny('delegation_inactive')
    const mintedAt = new Date(mintedAtMs)
    const assertionExpires = new Date(assertionExpiresMs)
    const minted = this.deps.assertionCodec.mint()
    const result = await this.deps.invocations.mint({
      invocationId: input.invocationId,
      delegationId: input.delegationId,
      assertionHash: minted.persistence.assertionHash,
      requestHash: input.requestHash,
      method: input.method,
      toolName: normalizedToolName,
      assertionExpires,
      mintedAt
    })

    switch (result.kind) {
      case 'issued':
        if (
          result.invocation.id !== input.invocationId ||
          result.invocation.delegationId !== input.delegationId ||
          result.invocation.requestHash !== input.requestHash ||
          result.invocation.method !== input.method ||
          result.invocation.toolName !== normalizedToolName ||
          result.invocation.assertionHash !== minted.persistence.assertionHash ||
          result.invocation.status !== 'issued' ||
          result.invocation.assertionExpires.getTime() !== assertionExpiresMs
        ) {
          return this.deny('invocation_parent_missing')
        }
        return {
          kind: 'minted',
          invocationId: input.invocationId,
          assertion: minted.plaintext,
          expiresAt: assertionExpires.toISOString()
        }
      case 'existing':
        return (
          this.classifyExisting(result.invocation, input, normalizedToolName) ?? this.deny('invocation_parent_missing')
        )
      case 'conflict': {
        const winner = await this.deps.invocations.get(input.invocationId)
        if (!winner) return this.deny('invocation_parent_missing')
        return this.classifyExisting(winner, input, normalizedToolName) ?? INVOCATION_CONFLICT
      }
      case 'denied':
        return this.deny('invocation_parent_missing')
    }
  }

  private validateCatalog(input: MintInvocationInput): string | null | undefined {
    if (input.method === 'tools/list') {
      if (input.toolName !== undefined) {
        this.reportDenied('tool_not_allowed')
        return undefined
      }
      return null
    }
    if (input.method !== 'tools/call') {
      this.reportDenied('method_not_allowed')
      return undefined
    }
    if (!input.toolName || !this.deps.isCuratedTool(input.toolName)) {
      this.reportDenied('tool_not_allowed')
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
    this.reportDenied(reason)
    return DELEGATION_DENIED
  }

  private denyNull(reason: DelegationDenialReason): null {
    this.reportDenied(reason)
    return null
  }

  private classifyExisting(
    current: McpInvocationRecord,
    input: MintInvocationInput,
    toolName: string | null
  ): MintInvocationResult | null {
    if (current.delegationId !== input.delegationId) return this.deny('delegation_binding')
    if (!sameInvocationBinding(current, input, toolName)) return INVOCATION_CONFLICT
    if (current.status === 'issued') return null
    return { kind: 'existing', invocationId: current.id, status: current.status }
  }

  private reportDenied(reason: DelegationDenialReason): void {
    try {
      this.deps.onDenied?.(reason)
    } catch {
      // Observability must never change the public authorization result.
    }
  }
}

const MAX_DATE_TIMESTAMP = 8.64e15

function isValidTimestamp(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_TIMESTAMP
}

function safeAddTimestamp(value: number, delta: number): number | null {
  if (!isValidTimestamp(value)) return null
  const result = value + delta
  return isValidTimestamp(result) ? result : null
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
