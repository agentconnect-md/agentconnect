import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MCP_ASSERTION_FEATURE } from '@agentconnect.md/protocol'
import { canView } from '../../domain/visibility.js'
import type {
  ClaimMcpInvocationInput,
  ClaimMcpInvocationResult,
  McpInvocationRecord,
  OrgMemberRole,
  WebchatMcpDelegationRecord
} from '../../persistence/ports.js'
import { InvocationAssertionCodec } from '../../registry/invocationAssertion.js'
import {
  InvocationAssertionAuthenticator,
  type InvocationAssertionDenialReason,
  type InvocationAssertionAuthenticatorDeps
} from './invocation-authenticator.js'

const NOW = Date.parse('2026-07-30T00:00:00.000Z')
const INVOCATION_ID = '11111111-1111-4111-8111-111111111111'
const DELEGATION_ID = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const AGENT_ID = '44444444-4444-4444-8444-444444444444'
const DAEMON_ID = '55555555-5555-4555-8555-555555555555'
const ORG_ID = 'org-1'
const USER_ID = 'user-1'
const PEPPER = 'test-pepper-that-is-at-least-thirty-two-characters'
const RESPONSE_CACHE_TTL_MS = 15 * 60_000
const MAX_RESPONSE_BYTES = 256 * 1024
const REQUEST_BYTES = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"listAgents"}}')
const REQUEST_HASH = createHash('sha256').update(REQUEST_BYTES).digest('hex')

function delegation(): WebchatMcpDelegationRecord {
  return {
    id: DELEGATION_ID,
    conversationId: CONVERSATION_ID,
    generation: 3,
    userId: USER_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    daemonId: DAEMON_ID,
    createdAt: new Date(NOW - 1_000),
    expiresAt: new Date(NOW + 60_000),
    revokedAt: null,
    revokedReason: null
  }
}

function invocation(assertionHash: string, patch: Partial<McpInvocationRecord> = {}): McpInvocationRecord {
  return {
    id: INVOCATION_ID,
    delegationId: DELEGATION_ID,
    assertionHash,
    requestHash: REQUEST_HASH,
    method: 'tools/call',
    toolName: 'listAgents',
    status: 'issued',
    assertionExpires: new Date(NOW + 30_000),
    startedAt: null,
    completedAt: null,
    responseStatus: null,
    responseBytes: null,
    createdAt: new Date(NOW),
    ...patch
  }
}

function harness() {
  const codec = new InvocationAssertionCodec(PEPPER)
  const minted = codec.mint()
  const state = {
    now: NOW,
    invocation: invocation(minted.persistence.assertionHash) as McpInvocationRecord | null,
    delegation: delegation() as WebchatMcpDelegationRecord | null,
    conversation: {
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID
    } as { conversationId: string; userId: string; orgId: string; agentId: string } | null,
    role: 'collaborator' as OrgMemberRole | null,
    agent: {
      id: AGENT_ID,
      orgId: ORG_ID,
      daemonId: DAEMON_ID,
      createdByUserId: USER_ID,
      visibility: 'org' as const,
      sharedWith: [] as string[]
    } as {
      id: string
      orgId: string
      daemonId: string | null
      createdByUserId: string | null
      visibility: 'org' | 'restricted'
      sharedWith: string[]
    } | null,
    presetAgentId: AGENT_ID as string | null,
    currentGeneration: 3,
    live: {
      reachable: true,
      state: 'READY',
      capabilities: { features: [DELEGATED_MCP_ASSERTION_FEATURE] }
    } as { reachable: boolean; state: string; capabilities?: { features?: string[] } } | undefined
  }
  const reasons: InvocationAssertionDenialReason[] = []
  const claimInputs: ClaimMcpInvocationInput[] = []
  const deps = {
    clock: { now: () => state.now },
    assertionCodec: codec,
    daemons: { get: vi.fn(() => state.live) },
    delegations: {
      getCurrent: vi.fn(async () =>
        state.delegation?.generation === state.currentGeneration ? state.delegation : null
      )
    },
    invocations: {
      getByAssertionHash: vi.fn(async (hash: string) =>
        state.invocation?.assertionHash === hash ? state.invocation : null
      ),
      claim: vi.fn(async (input: ClaimMcpInvocationInput): Promise<ClaimMcpInvocationResult> => {
        claimInputs.push(input)
        const current = state.invocation
        if (!current) return { kind: 'not_found' }
        const memberCanView =
          state.role !== null &&
          state.agent !== null &&
          canView(state.agent, { userId: input.userId, role: state.role })
        const exactAuthority =
          memberCanView &&
          state.agent?.id === input.agentId &&
          state.agent.orgId === input.orgId &&
          state.agent.daemonId === input.daemonId &&
          state.conversation?.conversationId === input.conversationId &&
          state.conversation.userId === input.userId &&
          state.conversation.orgId === input.orgId &&
          state.conversation.agentId === input.agentId &&
          state.currentGeneration === input.generation &&
          state.delegation?.id === input.delegationId &&
          state.delegation.generation === input.generation &&
          state.delegation.conversationId === input.conversationId &&
          state.delegation.userId === input.userId &&
          state.delegation.orgId === input.orgId &&
          state.delegation.agentId === input.agentId &&
          state.delegation.daemonId === input.daemonId &&
          state.delegation.revokedAt === null &&
          state.delegation.expiresAt.getTime() > input.now.getTime() &&
          state.presetAgentId === input.agentId
        if (!exactAuthority) return { kind: 'denied' }
        if (current.status !== 'issued') return { kind: 'existing', invocation: current }
        if (state.now >= current.assertionExpires.getTime()) return { kind: 'expired' }
        state.invocation = { ...current, status: 'running', startedAt: input.now }
        return { kind: 'claimed', invocation: state.invocation }
      })
    },
    isCuratedTool: (name: string) => name === 'listAgents',
    onDenied: (reason: InvocationAssertionDenialReason) => reasons.push(reason)
  } satisfies InvocationAssertionAuthenticatorDeps
  const authenticator = new InvocationAssertionAuthenticator(deps)
  const input = (
    patch: Partial<Parameters<InvocationAssertionAuthenticator['claim']>[0]> = {}
  ): Parameters<InvocationAssertionAuthenticator['claim']>[0] => ({
    bearer: minted.plaintext,
    invocationId: INVOCATION_ID,
    requestBytes: REQUEST_BYTES,
    parseMetadata: () => ({ method: 'tools/call', toolName: 'listAgents' }),
    ...patch
  })
  return {
    state,
    reasons,
    claimInputs,
    codec,
    minted,
    deps,
    authenticator,
    input
  }
}

describe('InvocationAssertionAuthenticator', () => {
  it('recognizes only the delegated assertion prefix and looks up the exact domain-separated peppered hash', async () => {
    const h = harness()
    const expected = createHmac('sha256', PEPPER)
      .update('agentconnect:mcp-invocation-assertion:v1\0')
      .update(h.minted.plaintext)
      .digest('hex')

    expect(await h.authenticator.claim(h.input())).toMatchObject({ kind: 'execute' })
    expect(h.deps.invocations.getByAssertionHash).toHaveBeenCalledWith(expected)
    expect(JSON.stringify(h.claimInputs)).not.toContain(h.minted.plaintext)

    const foreign = harness()
    expect(
      await foreign.authenticator.claim(
        foreign.input({ bearer: h.minted.plaintext.replace('ac_mcp_assert_v1_', 'ac_key_') })
      )
    ).toEqual({ kind: 'denied', reason: 'assertion_format' })
    expect(foreign.deps.invocations.getByAssertionHash).not.toHaveBeenCalled()
  })

  it('denies malformed or unequal invocation ids without parsing MCP JSON', async () => {
    for (const invocationId of ['not-a-uuid', '99999999-9999-4999-8999-999999999999']) {
      const h = harness()
      const parseMetadata = vi.fn(() => ({ method: 'tools/call' as const, toolName: 'listAgents' }))

      expect(await h.authenticator.claim(h.input({ invocationId, parseMetadata }))).toMatchObject({ kind: 'denied' })
      expect(parseMetadata).not.toHaveBeenCalled()
      expect(h.deps.invocations.claim).not.toHaveBeenCalled()
    }
  })

  it('hashes the exact raw request bytes and denies a mismatch before parsing', async () => {
    const h = harness()
    const parseMetadata = vi.fn(() => ({ method: 'tools/call' as const, toolName: 'listAgents' }))
    const changed = Buffer.concat([REQUEST_BYTES, Buffer.from('\n')])

    expect(await h.authenticator.claim(h.input({ requestBytes: changed, parseMetadata }))).toEqual({
      kind: 'denied',
      reason: 'request_hash_mismatch'
    })
    expect(parseMetadata).not.toHaveBeenCalled()
    expect(createHash('sha256').update(changed).digest('hex')).not.toBe(REQUEST_HASH)
  })

  it.each([
    ['tools/list carrying a tool', { method: 'tools/list' as const, toolName: 'listAgents' }],
    ['a different method', { method: 'tools/list' as const }],
    ['tools/call without a tool', { method: 'tools/call' as const }],
    ['a different tool', { method: 'tools/call' as const, toolName: 'whoami' }],
    ['an uncurated tool', { method: 'tools/call' as const, toolName: 'deleteOrganization' }]
  ])('denies parsed MCP metadata disagreement: %s', async (_name, metadata) => {
    const h = harness()
    expect(await h.authenticator.claim(h.input({ parseMetadata: () => metadata }))).toMatchObject({ kind: 'denied' })
    expect(h.deps.invocations.claim).not.toHaveBeenCalled()
  })

  it('allows tools/list only when both durable and parsed metadata omit toolName', async () => {
    const h = harness()
    h.state.invocation = invocation(h.minted.persistence.assertionHash, { method: 'tools/list', toolName: null })

    expect(await h.authenticator.claim(h.input({ parseMetadata: () => ({ method: 'tools/list' }) }))).toMatchObject({
      kind: 'execute'
    })
  })

  it('passes the complete durable authority binding into the final CAS claim', async () => {
    const h = harness()

    const result = await h.authenticator.claim(h.input())

    expect(result).toEqual({
      kind: 'execute',
      context: {
        invocationId: INVOCATION_ID,
        delegationId: DELEGATION_ID,
        conversationId: CONVERSATION_ID,
        agentId: AGENT_ID,
        daemonId: DAEMON_ID,
        orgId: ORG_ID,
        userId: USER_ID
      }
    })
    expect(h.claimInputs).toEqual([
      {
        invocationId: INVOCATION_ID,
        assertionHash: h.minted.persistence.assertionHash,
        delegationId: DELEGATION_ID,
        generation: 3,
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        orgId: ORG_ID,
        agentId: AGENT_ID,
        daemonId: DAEMON_ID,
        now: new Date(NOW)
      }
    ])
  })

  it('enforces the stored 30-second initial claim deadline', async () => {
    const h = harness()
    h.state.now = NOW + 30_000

    expect(await h.authenticator.claim(h.input())).toEqual({ kind: 'denied', reason: 'assertion_expired' })
    expect(h.claimInputs[0]?.now).toEqual(new Date(NOW + 30_000))
  })

  it('uses a fresh CAS timestamp after asynchronous live checks and MCP parsing', async () => {
    const h = harness()

    const result = await h.authenticator.claim(
      h.input({
        parseMetadata: () => {
          h.state.now = NOW + 30_000
          return { method: 'tools/call', toolName: 'listAgents' }
        }
      })
    )

    expect(result).toEqual({ kind: 'denied', reason: 'assertion_expired' })
    expect(h.claimInputs[0]?.now).toEqual(new Date(NOW + 30_000))
  })

  it('has one CAS execution winner and returns in_progress to the same assertion replay', async () => {
    const h = harness()

    const results = await Promise.all([h.authenticator.claim(h.input()), h.authenticator.claim(h.input())])

    expect(results.filter(({ kind }) => kind === 'execute')).toHaveLength(1)
    expect(results.filter(({ kind }) => kind === 'in_progress')).toHaveLength(1)
  })

  it.each(['succeeded', 'failed'] as const)(
    'replays byte-exact cached %s responses without executing',
    async (status) => {
      const h = harness()
      const bytes = Buffer.from([0, 255, 13, 10, status === 'succeeded' ? 1 : 2])
      h.state.invocation = invocation(h.minted.persistence.assertionHash, {
        status,
        responseStatus: status === 'succeeded' ? 200 : 500,
        responseBytes: bytes,
        completedAt: new Date(NOW - 1_000)
      })

      const result = await h.authenticator.claim(h.input())

      expect(result).toMatchObject({
        kind: 'completed',
        invocationStatus: status,
        responseStatus: status === 'succeeded' ? 200 : 500
      })
      if (result.kind !== 'completed') throw new Error('expected completed')
      expect(Buffer.from(result.responseBytes)).toEqual(bytes)
      expect(h.deps.invocations.claim).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['running', { kind: 'in_progress', retryAfterMs: 250 }],
    ['ambiguous', { kind: 'ambiguous' }]
  ] as const)('maps an authorized %s replay without another execution', async (status, expected) => {
    const h = harness()
    h.state.invocation = invocation(h.minted.persistence.assertionHash, {
      status,
      completedAt: status === 'ambiguous' ? new Date(NOW - 1_000) : null
    })

    expect(await h.authenticator.claim(h.input())).toEqual(expected)
  })

  it.each([
    [RESPONSE_CACHE_TTL_MS - 1, 'completed'],
    [RESPONSE_CACHE_TTL_MS, 'denied'],
    [RESPONSE_CACHE_TTL_MS + 1, 'denied']
  ] as const)('expires completed response replay at the exact 15-minute boundary: %dms', async (age, kind) => {
    const h = harness()
    h.state.now = NOW + age
    h.state.delegation = {
      ...h.state.delegation!,
      expiresAt: new Date(NOW + RESPONSE_CACHE_TTL_MS * 2)
    }
    h.state.invocation = invocation(h.minted.persistence.assertionHash, {
      status: 'succeeded',
      completedAt: new Date(NOW),
      responseStatus: 200,
      responseBytes: Buffer.from('cached')
    })

    expect((await h.authenticator.claim(h.input())).kind).toBe(kind)
  })

  it.each([
    [RESPONSE_CACHE_TTL_MS - 1, 'ambiguous'],
    [RESPONSE_CACHE_TTL_MS, 'denied'],
    [RESPONSE_CACHE_TTL_MS + 1, 'denied']
  ] as const)('expires ambiguous replay at the exact 15-minute boundary: %dms', async (age, kind) => {
    const h = harness()
    h.state.now = NOW + age
    h.state.delegation = {
      ...h.state.delegation!,
      expiresAt: new Date(NOW + RESPONSE_CACHE_TTL_MS * 2)
    }
    h.state.invocation = invocation(h.minted.persistence.assertionHash, {
      status: 'ambiguous',
      completedAt: new Date(NOW)
    })

    expect((await h.authenticator.claim(h.input())).kind).toBe(kind)
  })

  it.each([
    ['missing completion time', { completedAt: null }],
    ['invalid completion time', { completedAt: new Date(Number.NaN) }],
    ['overflowing completion time', { completedAt: new Date(8.64e15) }],
    ['missing HTTP status', { responseStatus: null }],
    ['status below HTTP range', { responseStatus: 99 }],
    ['status above HTTP range', { responseStatus: 600 }],
    ['non-integer HTTP status', { responseStatus: 200.5 }],
    ['missing response bytes', { responseBytes: null }],
    ['non-byte response body', { responseBytes: 'cached' as unknown as Uint8Array }],
    ['oversized response bytes', { responseBytes: new Uint8Array(MAX_RESPONSE_BYTES + 1) }]
  ] as const)('fails closed for corrupt cached terminal rows: %s', async (_name, patch) => {
    const h = harness()
    h.state.invocation = invocation(h.minted.persistence.assertionHash, {
      status: 'succeeded',
      completedAt: new Date(NOW),
      responseStatus: 200,
      responseBytes: Buffer.from('cached'),
      ...patch
    })

    expect(await h.authenticator.claim(h.input())).toEqual({
      kind: 'denied',
      reason: 'cached_response_invalid'
    })
  })

  it('clones cached response bytes before returning them', async () => {
    const h = harness()
    const stored = Buffer.from([1, 2, 3])
    h.state.invocation = invocation(h.minted.persistence.assertionHash, {
      status: 'succeeded',
      completedAt: new Date(NOW),
      responseStatus: 200,
      responseBytes: stored
    })

    const result = await h.authenticator.claim(h.input())

    if (result.kind !== 'completed') throw new Error('expected completed')
    result.responseBytes[0] = 9
    expect(stored).toEqual(Buffer.from([1, 2, 3]))
  })

  it('classifies replay against a fresh finite observation time after the transaction', async () => {
    const h = harness()
    const cached = invocation(h.minted.persistence.assertionHash, {
      status: 'succeeded',
      completedAt: new Date(NOW),
      responseStatus: 200,
      responseBytes: Buffer.from('cached')
    })
    h.state.invocation = cached
    h.deps.invocations.claim.mockImplementationOnce(async () => {
      h.state.now = NOW + RESPONSE_CACHE_TTL_MS
      return { kind: 'existing', invocation: cached }
    })

    expect(await h.authenticator.claim(h.input())).toEqual({
      kind: 'denied',
      reason: 'cached_response_invalid'
    })
  })

  it.each([
    ['unknown assertion', (h: ReturnType<typeof harness>) => (h.state.invocation = null)],
    ['removed member', (h: ReturnType<typeof harness>) => (h.state.role = null)],
    [
      'hidden agent',
      (h: ReturnType<typeof harness>) =>
        (h.state.agent = {
          ...h.state.agent!,
          createdByUserId: 'other-user',
          visibility: 'restricted',
          sharedWith: []
        })
    ],
    ['non-preset', (h: ReturnType<typeof harness>) => (h.state.presetAgentId = null)],
    [
      'revoked delegation',
      (h: ReturnType<typeof harness>) => (h.state.delegation = { ...h.state.delegation!, revokedAt: new Date(NOW - 1) })
    ],
    [
      'expired delegation',
      (h: ReturnType<typeof harness>) => (h.state.delegation = { ...h.state.delegation!, expiresAt: new Date(NOW) })
    ],
    [
      'stale generation',
      (h: ReturnType<typeof harness>) => (h.state.delegation = { ...h.state.delegation!, generation: 4 })
    ],
    [
      'wrong agent',
      (h: ReturnType<typeof harness>) =>
        (h.state.delegation = { ...h.state.delegation!, agentId: '99999999-9999-4999-8999-999999999999' })
    ],
    [
      'wrong conversation',
      (h: ReturnType<typeof harness>) =>
        (h.state.delegation = {
          ...h.state.delegation!,
          conversationId: '99999999-9999-4999-8999-999999999999'
        })
    ],
    [
      'placement mismatch',
      (h: ReturnType<typeof harness>) =>
        (h.state.agent = {
          ...h.state.agent!,
          daemonId: '99999999-9999-4999-8999-999999999999'
        })
    ],
    [
      'capability mismatch',
      (h: ReturnType<typeof harness>) => (h.state.live = { ...h.state.live!, capabilities: { features: [] } })
    ]
  ])('returns only the closed denied contract for %s', async (_name, arrange) => {
    const h = harness()
    arrange(h)

    const result = await h.authenticator.claim(h.input())

    expect(result.kind).toBe('denied')
    if (result.kind !== 'denied') throw new Error('expected denied')
    expect(h.reasons).toContain(result.reason)
    expect(Object.keys(result).sort()).toEqual(['kind', 'reason'])
    expect(JSON.stringify(result)).not.toContain(h.minted.plaintext)
    expect(JSON.stringify(result)).not.toContain(h.minted.persistence.assertionHash)
  })

  it('revalidates all durable facts transactionally before observing replay state', async () => {
    const h = harness()
    h.state.invocation = invocation(h.minted.persistence.assertionHash, { status: 'running' })
    h.state.role = null

    expect(await h.authenticator.claim(h.input())).toEqual({ kind: 'denied', reason: 'claim_denied' })
    expect(h.deps.invocations.claim).toHaveBeenCalledOnce()
  })
})
