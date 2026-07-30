import { createHash } from 'node:crypto'
import type { McpInvocationMint } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import type { Clock } from '../../domain/clock.js'
import type { McpInvocationRecord, McpInvocationRepo, WebchatMcpDelegationRepo } from '../../persistence/ports.js'
import type { InvocationAssertionCodec } from '../../registry/invocationAssertion.js'
import {
  resolveLiveWebchatMcpAuthority,
  type LiveWebchatMcpAuthorityDeps,
  type WebchatMcpAuthorityDenialReason
} from '../../registry/webchatMcpAuthority.js'

export interface InvocationContext {
  invocationId: string
  delegationId: string
  conversationId: string
  agentId: string
  daemonId: string
  orgId: string
  userId: string
}

export type InvocationAssertionDenialReason =
  | WebchatMcpAuthorityDenialReason
  | 'assertion_format'
  | 'assertion_unknown'
  | 'invocation_id_invalid'
  | 'invocation_id_mismatch'
  | 'request_hash_mismatch'
  | 'request_metadata_invalid'
  | 'method_mismatch'
  | 'tool_mismatch'
  | 'delegation_inactive'
  | 'delegation_binding'
  | 'assertion_expired'
  | 'claim_denied'
  | 'claim_state_invalid'
  | 'cached_response_invalid'

export type InvocationAssertionClaimResult =
  | { kind: 'execute'; context: InvocationContext }
  | {
      kind: 'completed'
      invocationStatus: 'succeeded' | 'failed'
      responseStatus: number
      responseBytes: Uint8Array
    }
  | { kind: 'in_progress'; retryAfterMs: number }
  | { kind: 'ambiguous' }
  | { kind: 'denied'; reason: InvocationAssertionDenialReason }

export type ParsedInvocationMetadata = Pick<McpInvocationMint, 'method' | 'toolName'>

export interface InvocationAssertionClaimInput {
  bearer: string
  invocationId: string
  requestBytes: Uint8Array
  /** Deliberately lazy: assertion/id/body-hash failures never parse JSON. */
  parseMetadata(): ParsedInvocationMetadata | Promise<ParsedInvocationMetadata>
}

export interface InvocationAssertionAuthenticatorDeps extends LiveWebchatMcpAuthorityDeps {
  clock: Pick<Clock, 'now'>
  assertionCodec: Pick<InvocationAssertionCodec, 'hash'>
  delegations: Pick<WebchatMcpDelegationRepo, 'getCurrent'>
  invocations: Pick<McpInvocationRepo, 'getByAssertionHash' | 'claim'>
  isCuratedTool(toolName: string): boolean
  onDenied?: (reason: InvocationAssertionDenialReason) => void
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IN_PROGRESS_RETRY_AFTER_MS = 250

export class InvocationAssertionAuthenticator {
  constructor(private readonly deps: InvocationAssertionAuthenticatorDeps) {}

  async claim(input: InvocationAssertionClaimInput): Promise<InvocationAssertionClaimResult> {
    const assertionHash = this.deps.assertionCodec.hash(input.bearer)
    if (!assertionHash) return this.deny('assertion_format')

    const invocation = await this.deps.invocations.getByAssertionHash(assertionHash)
    if (!invocation) return this.deny('assertion_unknown')
    if (!UUID_RE.test(input.invocationId)) return this.deny('invocation_id_invalid')
    if (invocation.id !== input.invocationId) return this.deny('invocation_id_mismatch')

    const requestHash = createHash('sha256').update(input.requestBytes).digest('hex')
    if (requestHash !== invocation.requestHash) return this.deny('request_hash_mismatch')

    const nowMs = this.deps.clock.now()
    if (!Number.isFinite(nowMs)) return this.deny('claim_denied')
    const delegation = await this.deps.delegations.getCurrent(invocation.delegationId)
    if (
      !delegation ||
      delegation.id !== invocation.delegationId ||
      delegation.revokedAt !== null ||
      delegation.expiresAt.getTime() <= nowMs
    ) {
      return this.deny('delegation_inactive')
    }

    const authority = await resolveLiveWebchatMcpAuthority(this.deps, {
      conversationId: delegation.conversationId,
      expectedUserId: delegation.userId,
      orgId: delegation.orgId,
      agentId: delegation.agentId,
      daemonId: delegation.daemonId
    })
    if (!authority.ok) return this.deny(authority.reason)

    let metadata: ParsedInvocationMetadata
    try {
      metadata = await input.parseMetadata()
    } catch {
      return this.deny('request_metadata_invalid')
    }
    const metadataDenial = this.validateMetadata(invocation, metadata)
    if (metadataDenial) return this.deny(metadataDenial)

    if (invocation.status !== 'issued') return this.classifyReplay(invocation)

    const context: InvocationContext = {
      invocationId: invocation.id,
      delegationId: delegation.id,
      conversationId: delegation.conversationId,
      agentId: delegation.agentId,
      daemonId: delegation.daemonId,
      orgId: delegation.orgId,
      userId: authority.userId
    }
    // Authority resolution and lazy JSON parsing may take time. The repository's
    // deadline predicates must use the instant of the CAS attempt, not request
    // admission time, or a near-expiry assertion could start after 30 seconds.
    const claimNowMs = this.deps.clock.now()
    if (!Number.isFinite(claimNowMs)) return this.deny('claim_denied')
    const claimed = await this.deps.invocations.claim({
      invocationId: invocation.id,
      assertionHash,
      delegationId: delegation.id,
      generation: delegation.generation,
      conversationId: delegation.conversationId,
      userId: authority.userId,
      orgId: OrgId(delegation.orgId),
      agentId: AgentId(delegation.agentId),
      daemonId: DaemonId(delegation.daemonId),
      now: new Date(claimNowMs)
    })
    if (claimed.kind === 'claimed') {
      return sameInvocation(claimed.invocation, invocation)
        ? { kind: 'execute', context }
        : this.deny('claim_state_invalid')
    }
    if (claimed.kind === 'existing') {
      return sameInvocation(claimed.invocation, invocation)
        ? this.classifyReplay(claimed.invocation)
        : this.deny('claim_state_invalid')
    }
    if (claimed.kind === 'expired') return this.deny('assertion_expired')
    return this.deny('claim_denied')
  }

  private validateMetadata(
    invocation: McpInvocationRecord,
    metadata: ParsedInvocationMetadata
  ): 'request_metadata_invalid' | 'method_mismatch' | 'tool_mismatch' | null {
    if (!metadata || (metadata.method !== 'tools/list' && metadata.method !== 'tools/call')) {
      return 'request_metadata_invalid'
    }
    if (metadata.method === 'tools/list' && metadata.toolName !== undefined) return 'tool_mismatch'
    if (metadata.method === 'tools/call') {
      if (!metadata.toolName || !this.deps.isCuratedTool(metadata.toolName)) return 'tool_mismatch'
    }
    if (metadata.method !== invocation.method) return 'method_mismatch'
    const toolName = metadata.method === 'tools/call' ? metadata.toolName : null
    return toolName === invocation.toolName ? null : 'tool_mismatch'
  }

  private classifyReplay(invocation: McpInvocationRecord): InvocationAssertionClaimResult {
    if (invocation.status === 'running') {
      return { kind: 'in_progress', retryAfterMs: IN_PROGRESS_RETRY_AFTER_MS }
    }
    if (invocation.status === 'ambiguous') return { kind: 'ambiguous' }
    if (invocation.status === 'succeeded' || invocation.status === 'failed') {
      if (invocation.responseStatus === null || invocation.responseBytes === null) {
        return this.deny('cached_response_invalid')
      }
      return {
        kind: 'completed',
        invocationStatus: invocation.status,
        responseStatus: invocation.responseStatus,
        responseBytes: new Uint8Array(invocation.responseBytes)
      }
    }
    return this.deny('claim_state_invalid')
  }

  private deny(reason: InvocationAssertionDenialReason): InvocationAssertionClaimResult {
    try {
      this.deps.onDenied?.(reason)
    } catch {
      // Authorization results do not depend on observability.
    }
    return { kind: 'denied', reason }
  }
}

function sameInvocation(left: McpInvocationRecord, right: McpInvocationRecord): boolean {
  return (
    left.id === right.id &&
    left.delegationId === right.delegationId &&
    left.assertionHash === right.assertionHash &&
    left.requestHash === right.requestHash &&
    left.method === right.method &&
    left.toolName === right.toolName
  )
}
