import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  DELEGATED_MCP_ASSERTION_FEATURE,
  type McpInvocationMint,
  type WebchatMcpDelegationReference
} from '@agentconnect.md/protocol'
import type {
  EstablishWebchatMcpDelegationInput,
  McpInvocationRecord,
  MintMcpInvocationInput,
  WebchatMcpDelegationRecord
} from '../persistence/ports.js'
import { InvocationAssertionCodec } from './invocationAssertion.js'
import {
  DELEGATION_DENIED,
  INVOCATION_CONFLICT,
  MCP_INVOCATION_ASSERTION_TTL_MS,
  WEBCHAT_MCP_DELEGATION_DEFAULT_TTL_MS,
  WebchatMcpDelegationService,
  type DelegationDenialReason,
  type DelegationReference,
  type MintInvocationInput,
  type WebchatMcpDelegationServiceDeps
} from './webchatMcpDelegationService.js'

const NOW = Date.parse('2026-07-30T04:00:00.000Z')
const USER_ID = 'user-1'
const OTHER_USER_ID = 'user-2'
const ORG_ID = 'org-1'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222223'
const DAEMON_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_DAEMON_ID = '55555555-5555-4555-8555-555555555556'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const DELEGATION_ID = '11111111-1111-4111-8111-111111111111'
const INVOCATION_ID = '44444444-4444-4444-8444-444444444444'
const REQUEST_HASH = 'a'.repeat(64)
const CURATED_TOOL = 'listAgents'

const activeDelegation = (): WebchatMcpDelegationRecord => ({
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
})

function invocation(
  input: Partial<McpInvocationRecord> & Pick<McpInvocationRecord, 'status'> = { status: 'issued' }
): McpInvocationRecord {
  return {
    id: INVOCATION_ID,
    delegationId: DELEGATION_ID,
    assertionHash: 'stored-hash',
    requestHash: REQUEST_HASH,
    method: 'tools/list',
    toolName: null,
    status: input.status,
    assertionExpires: new Date(NOW + 30_000),
    startedAt: null,
    completedAt: null,
    responseStatus: null,
    responseBytes: null,
    createdAt: new Date(NOW),
    ...input
  }
}

function invocationFromMint(input: MintMcpInvocationInput): McpInvocationRecord {
  return {
    id: input.invocationId,
    delegationId: input.delegationId,
    assertionHash: input.assertionHash,
    requestHash: input.requestHash,
    method: input.method,
    toolName: input.toolName ?? null,
    status: 'issued',
    assertionExpires: input.assertionExpires,
    startedAt: null,
    completedAt: null,
    responseStatus: null,
    responseBytes: null,
    createdAt: input.mintedAt
  }
}

function harness() {
  const state = {
    now: NOW,
    conversation: {
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID
    } as { conversationId: string; userId: string; orgId: string; agentId: string } | null,
    role: 'collaborator' as 'owner' | 'collaborator' | 'viewer' | null,
    agent: {
      id: AGENT_ID,
      orgId: ORG_ID,
      daemonId: DAEMON_ID,
      createdByUserId: OTHER_USER_ID,
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
    live: {
      reachable: true,
      state: 'READY',
      capabilities: { features: [DELEGATED_MCP_ASSERTION_FEATURE] }
    } as
      | {
          reachable: boolean
          state: string
          capabilities?: { features?: string[] }
        }
      | undefined,
    delegation: activeDelegation() as WebchatMcpDelegationRecord | null,
    existingInvocation: null as McpInvocationRecord | null
  }
  const reasons: DelegationDenialReason[] = []
  const metricDelegation = vi.fn()
  const metricAssertion = vi.fn()
  const established: EstablishWebchatMcpDelegationInput[] = []
  const minted: MintMcpInvocationInput[] = []
  const codec = new InvocationAssertionCodec('test-pepper-that-is-at-least-thirty-two-characters')
  const codecMint = vi.spyOn(codec, 'mint')
  const deps = {
    clock: { now: () => state.now },
    assertionCodec: codec,
    isCuratedTool: (name: string) => name === CURATED_TOOL,
    conversations: {
      findOwner: vi.fn(async (conversationId: string, agentId: string) => {
        const row = state.conversation
        return row && row.conversationId === conversationId && row.agentId === agentId ? row.userId : null
      }),
      owns: vi.fn(async (binding: { conversationId: string; userId: string; orgId: string; agentId: string }) => {
        const row = state.conversation
        return (
          row !== null &&
          row.conversationId === binding.conversationId &&
          row.userId === binding.userId &&
          row.orgId === binding.orgId &&
          row.agentId === binding.agentId
        )
      })
    },
    orgs: {
      roleOf: vi.fn(async (orgId: string, userId: string) =>
        orgId === ORG_ID && userId === USER_ID ? state.role : null
      )
    },
    agents: { get: vi.fn(async (agentId: string) => (agentId === AGENT_ID ? state.agent : null)) },
    presets: {
      get: vi.fn(async (orgId: string, preset: 'general') =>
        orgId !== ORG_ID || preset !== 'general' || state.presetAgentId === null
          ? null
          : {
              orgId: ORG_ID,
              preset: 'general' as const,
              agentId: state.presetAgentId,
              status: 'created' as const,
              placementSettledAt: new Date(NOW),
              createdAt: new Date(NOW)
            }
      )
    },
    daemons: { get: vi.fn((daemonId: string) => (daemonId === DAEMON_ID ? state.live : undefined)) },
    delegations: {
      establish: vi.fn(async (input: EstablishWebchatMcpDelegationInput) => {
        established.push(input)
        if (state.delegation && state.delegation.expiresAt.getTime() > input.expiresAt.getTime()) {
          state.delegation = { ...state.delegation, expiresAt: input.expiresAt }
        }
        return state.delegation
      }),
      getCurrent: vi.fn(async (delegationId: string) =>
        state.delegation?.id === delegationId ? state.delegation : null
      )
    },
    invocations: {
      get: vi.fn(async (invocationId: string) =>
        state.existingInvocation?.id === invocationId ? state.existingInvocation : null
      ),
      mint: vi.fn(async (input: MintMcpInvocationInput) => {
        minted.push(input)
        return { kind: 'issued' as const, invocation: invocationFromMint(input) }
      })
    },
    onDenied: (reason: DelegationDenialReason) => reasons.push(reason),
    metrics: { delegation: metricDelegation, assertion: metricAssertion }
  } satisfies WebchatMcpDelegationServiceDeps
  return {
    state,
    reasons,
    established,
    minted,
    codec,
    codecMint,
    metricDelegation,
    metricAssertion,
    deps,
    service: new WebchatMcpDelegationService(deps)
  }
}

const establishInput = () => ({
  conversationId: CONVERSATION_ID,
  verifiedUserId: USER_ID,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  daemonId: DAEMON_ID
})

const mintInput = (): MintInvocationInput => ({
  authenticatedDaemonId: DAEMON_ID,
  delegationId: DELEGATION_ID,
  generation: 3,
  agentId: AGENT_ID,
  conversationId: CONVERSATION_ID,
  invocationId: INVOCATION_ID,
  requestHash: REQUEST_HASH,
  method: 'tools/list'
})

expectTypeOf<DelegationReference>().toEqualTypeOf<WebchatMcpDelegationReference>()
expectTypeOf<Omit<MintInvocationInput, 'authenticatedDaemonId'>>().toEqualTypeOf<McpInvocationMint>()

describe('WebchatMcpDelegationService.establish', () => {
  it('records reused delegation and denial transitions without identifiers', async () => {
    const h = harness()

    await expect(h.service.establish(establishInput())).resolves.toMatchObject({ id: DELEGATION_ID })
    expect(h.metricDelegation).not.toHaveBeenCalled()

    h.state.conversation = null
    await expect(h.service.establish(establishInput())).resolves.toBeNull()
    expect(h.metricDelegation).toHaveBeenLastCalledWith('denied', 'conversation_binding')
  })

  it('derives the actor from the durable conversation and caps the default delegation at twelve hours', async () => {
    const h = harness()

    const result = await h.service.establish(establishInput())

    expect(result).toEqual({
      id: DELEGATION_ID,
      generation: 3,
      expiresAt: new Date(NOW + 60_000).toISOString()
    })
    expect(h.established).toEqual([
      {
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        orgId: ORG_ID,
        agentId: AGENT_ID,
        daemonId: DAEMON_ID,
        now: new Date(NOW),
        expiresAt: new Date(NOW + WEBCHAT_MCP_DELEGATION_DEFAULT_TTL_MS)
      }
    ])
  })

  it('caps delegation authority to an earlier logical-session expiry', async () => {
    const h = harness()
    const sessionExpiresAt = new Date(NOW + 5_000)

    const result = await h.service.establish({ ...establishInput(), sessionExpiresAt })

    expect(result).toEqual({
      id: DELEGATION_ID,
      generation: 3,
      expiresAt: sessionExpiresAt.toISOString()
    })
    expect(h.established[0]?.expiresAt).toEqual(sessionExpiresAt)
  })

  it('reuses the generation while monotonically shortening reconnect session ceilings', async () => {
    const h = harness()
    const firstCeiling = new Date(NOW + 30_000)
    const reconnectCeiling = new Date(NOW + 5_000)

    const first = await h.service.establish({ ...establishInput(), sessionExpiresAt: firstCeiling })
    const reconnect = await h.service.establish({ ...establishInput(), sessionExpiresAt: reconnectCeiling })

    expect(first).toEqual({
      id: DELEGATION_ID,
      generation: 3,
      expiresAt: firstCeiling.toISOString()
    })
    expect(reconnect).toEqual({
      id: DELEGATION_ID,
      generation: 3,
      expiresAt: reconnectCeiling.toISOString()
    })
    expect(h.established.map(({ expiresAt }) => expiresAt)).toEqual([firstCeiling, reconnectCeiling])
  })

  it('fails closed if persistence returns a reference beyond the requested session ceiling', async () => {
    const h = harness()
    const sessionExpiresAt = new Date(NOW + 5_000)
    h.deps.delegations.establish.mockResolvedValueOnce(activeDelegation())

    expect(await h.service.establish({ ...establishInput(), sessionExpiresAt })).toBeNull()
  })

  it.each([
    ['a NaN clock', Number.NaN, undefined],
    ['an infinite clock', Number.POSITIVE_INFINITY, undefined],
    ['a timestamp whose default expiry overflows Date', 8.64e15 - 1_000, undefined],
    ['an invalid session expiry', NOW, new Date(Number.NaN)]
  ])('fails closed for %s', async (_name, clockNow, sessionExpiresAt) => {
    const h = harness()
    h.state.now = clockNow

    expect(await h.service.establish({ ...establishInput(), sessionExpiresAt })).toBeNull()
    expect(h.established).toEqual([])
  })

  it.each([
    ['a revoked row', (row: WebchatMcpDelegationRecord) => ({ ...row, revokedAt: new Date(NOW) })],
    [
      'a wrong authority binding',
      (row: WebchatMcpDelegationRecord) => ({ ...row, conversationId: 'wrong-conversation' })
    ],
    ['an invalid generation', (row: WebchatMcpDelegationRecord) => ({ ...row, generation: 0 })]
  ])('rejects %s returned by persistence', async (_name, mutate) => {
    const h = harness()
    h.deps.delegations.establish.mockResolvedValueOnce(mutate(activeDelegation()))

    expect(await h.service.establish(establishInput())).toBeNull()
  })

  it('checks returned delegation expiry against a fresh post-persistence clock', async () => {
    const h = harness()
    h.deps.delegations.establish.mockImplementationOnce(async () => {
      h.state.now = NOW + 61_000
      return activeDelegation()
    })

    expect(await h.service.establish(establishInput())).toBeNull()
  })

  it.each([
    ['verified owner mismatch', (h: ReturnType<typeof harness>) => ({ verifiedUserId: OTHER_USER_ID })],
    ['organization mismatch', (h: ReturnType<typeof harness>) => ({ orgId: 'org-2' })],
    ['agent mismatch', (h: ReturnType<typeof harness>) => ({ agentId: OTHER_AGENT_ID })],
    [
      'missing membership',
      (h: ReturnType<typeof harness>) => {
        h.state.role = null
        return {}
      }
    ],
    [
      'missing agent',
      (h: ReturnType<typeof harness>) => {
        h.state.agent = null
        return {}
      }
    ],
    [
      'hidden agent',
      (h: ReturnType<typeof harness>) => {
        h.state.agent = { ...h.state.agent!, visibility: 'restricted', sharedWith: [] }
        return {}
      }
    ],
    [
      'not the general preset relation',
      (h: ReturnType<typeof harness>) => {
        h.state.presetAgentId = OTHER_AGENT_ID
        return {}
      }
    ],
    [
      'unplaced agent',
      (h: ReturnType<typeof harness>) => {
        h.state.agent = { ...h.state.agent!, daemonId: null }
        return {}
      }
    ],
    ['wrong target daemon', (h: ReturnType<typeof harness>) => ({ daemonId: OTHER_DAEMON_ID })],
    [
      'offline daemon',
      (h: ReturnType<typeof harness>) => {
        h.state.live = undefined
        return {}
      }
    ],
    [
      'ineligible daemon lifecycle state',
      (h: ReturnType<typeof harness>) => {
        h.state.live = { ...h.state.live!, state: 'DRAINING' }
        return {}
      }
    ],
    [
      'missing delegated assertion feature',
      (h: ReturnType<typeof harness>) => {
        h.state.live = { ...h.state.live!, capabilities: { features: [] } }
        return {}
      }
    ]
  ])('does not establish for %s', async (_name, arrange) => {
    const h = harness()
    const patch = arrange(h)

    expect(await h.service.establish({ ...establishInput(), ...patch })).toBeNull()
    expect(h.established).toEqual([])
  })
})

describe('WebchatMcpDelegationService.mintInvocation', () => {
  it('records minted and conflicting assertion transitions exactly once', async () => {
    const h = harness()
    await expect(h.service.mintInvocation(mintInput())).resolves.toMatchObject({ kind: 'minted' })
    expect(h.metricAssertion).toHaveBeenCalledWith('minted')

    h.state.existingInvocation = invocation({ status: 'issued', requestHash: 'b'.repeat(64) })
    await expect(h.service.mintInvocation(mintInput())).resolves.toEqual(INVOCATION_CONFLICT)
    expect(h.metricAssertion).toHaveBeenLastCalledWith('conflicted')
  })

  it('returns exactly the same public denial for missing, removed, and hidden authority', async () => {
    const cases = [
      (h: ReturnType<typeof harness>) => {
        h.state.delegation = null
      },
      (h: ReturnType<typeof harness>) => {
        h.state.conversation = null
      },
      (h: ReturnType<typeof harness>) => {
        h.state.role = null
      },
      (h: ReturnType<typeof harness>) => {
        h.state.agent = { ...h.state.agent!, visibility: 'restricted', sharedWith: [] }
      }
    ]
    const serialized: string[] = []
    const reasons: DelegationDenialReason[] = []

    for (const arrange of cases) {
      const h = harness()
      arrange(h)
      serialized.push(JSON.stringify(await h.service.mintInvocation(mintInput())))
      reasons.push(...h.reasons)
    }

    expect(new Set(serialized)).toEqual(new Set([JSON.stringify(DELEGATION_DENIED)]))
    expect(new Set(reasons).size).toBeGreaterThan(1)
    expect(reasons.every((reason) => !reason.includes(USER_ID) && !reason.includes(AGENT_ID))).toBe(true)
  })

  it.each([
    [
      'revoked delegation',
      (h: ReturnType<typeof harness>, input: MintInvocationInput) => {
        h.state.delegation = { ...h.state.delegation!, revokedAt: new Date(NOW - 1) }
        return input
      }
    ],
    [
      'expired delegation',
      (h: ReturnType<typeof harness>, input: MintInvocationInput) => {
        h.state.delegation = { ...h.state.delegation!, expiresAt: new Date(NOW) }
        return input
      }
    ],
    ['stale generation', (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({ ...input, generation: 2 })],
    [
      'wrong authenticated daemon',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({
        ...input,
        authenticatedDaemonId: OTHER_DAEMON_ID
      })
    ],
    [
      'wrong durable agent binding',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({ ...input, agentId: OTHER_AGENT_ID })
    ],
    [
      'wrong durable conversation binding',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({
        ...input,
        conversationId: '33333333-3333-4333-8333-333333333334'
      })
    ],
    [
      'newly wrong preset relation',
      (h: ReturnType<typeof harness>, input: MintInvocationInput) => {
        h.state.presetAgentId = OTHER_AGENT_ID
        return input
      }
    ],
    [
      'new placement',
      (h: ReturnType<typeof harness>, input: MintInvocationInput) => {
        h.state.agent = { ...h.state.agent!, daemonId: OTHER_DAEMON_ID }
        return input
      }
    ],
    [
      'offline placed daemon',
      (h: ReturnType<typeof harness>, input: MintInvocationInput) => {
        h.state.live = undefined
        return input
      }
    ],
    [
      'daemon without the feature',
      (h: ReturnType<typeof harness>, input: MintInvocationInput) => {
        h.state.live = { ...h.state.live!, capabilities: { features: [] } }
        return input
      }
    ],
    [
      'unknown method',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) =>
        ({ ...input, method: 'resources/list' }) as unknown as MintInvocationInput
    ],
    [
      'tools/list with a tool name',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({ ...input, toolName: CURATED_TOOL })
    ],
    [
      'tools/call without a tool name',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({
        ...input,
        method: 'tools/call',
        toolName: undefined
      })
    ],
    [
      'tools/call outside the curated catalog',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({
        ...input,
        method: 'tools/call',
        toolName: 'deleteOrganization'
      })
    ]
  ])('denies %s without touching the invocation ledger', async (_name, arrange) => {
    const h = harness()
    const input = arrange(h, mintInput())

    expect(await h.service.mintInvocation(input)).toEqual(DELEGATION_DENIED)
    expect(h.minted).toEqual([])
    expect(h.codecMint).not.toHaveBeenCalled()
  })

  it('mints one 30-second assertion and passes only its peppered hash to persistence', async () => {
    const h = harness()

    const result = await h.service.mintInvocation({
      ...mintInput(),
      method: 'tools/call',
      toolName: CURATED_TOOL
    })

    expect(result).toMatchObject({
      kind: 'minted',
      invocationId: INVOCATION_ID,
      expiresAt: new Date(NOW + MCP_INVOCATION_ASSERTION_TTL_MS).toISOString()
    })
    if (result.kind !== 'minted') throw new Error('expected minted')
    expect(h.minted).toHaveLength(1)
    expect(h.minted[0]).toEqual({
      invocationId: INVOCATION_ID,
      delegationId: DELEGATION_ID,
      assertionHash: h.codec.hash(result.assertion),
      requestHash: REQUEST_HASH,
      method: 'tools/call',
      toolName: CURATED_TOOL,
      assertionExpires: new Date(NOW + 30_000),
      mintedAt: new Date(NOW)
    })
    expect(JSON.stringify(h.minted[0])).not.toContain(result.assertion)
  })

  it('takes a fresh issuance timestamp after asynchronous entitlement checks', async () => {
    const h = harness()
    h.deps.invocations.get.mockImplementationOnce(async () => {
      h.state.now = NOW + 5_000
      return null
    })

    const result = await h.service.mintInvocation(mintInput())

    expect(result).toMatchObject({
      kind: 'minted',
      expiresAt: new Date(NOW + 35_000).toISOString()
    })
    expect(h.minted[0]).toMatchObject({
      mintedAt: new Date(NOW + 5_000),
      assertionExpires: new Date(NOW + 35_000)
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 - 1_000])(
    'fails closed when the issuance clock is %s',
    async (invalidNow) => {
      const h = harness()
      h.deps.invocations.get.mockImplementationOnce(async () => {
        h.state.now = invalidNow
        return null
      })

      expect(await h.service.mintInvocation(mintInput())).toEqual(DELEGATION_DENIED)
      expect(h.codecMint).not.toHaveBeenCalled()
      expect(h.minted).toEqual([])
    }
  )

  it('preserves the public denial shape when the denial observer throws', async () => {
    const h = harness()
    const service = new WebchatMcpDelegationService({
      ...h.deps,
      onDenied: () => {
        throw new Error('metrics unavailable')
      }
    })
    h.state.delegation = null

    await expect(service.mintInvocation(mintInput())).resolves.toEqual(DELEGATION_DENIED)
  })

  it('rotates the assertion for an identical issued retry', async () => {
    const h = harness()
    h.state.existingInvocation = invocation({ status: 'issued' })

    const result = await h.service.mintInvocation(mintInput())

    expect(result.kind).toBe('minted')
    expect(h.codecMint).toHaveBeenCalledOnce()
    expect(h.minted).toHaveLength(1)
  })

  it('returns conflict for a conflicting invocation retry without minting plaintext', async () => {
    const h = harness()
    h.state.existingInvocation = invocation({ status: 'issued', requestHash: 'b'.repeat(64) })

    const result = await h.service.mintInvocation(mintInput())

    expect(result).toEqual({
      kind: 'conflict',
      code: 'INVOCATION_CONFLICT',
      message: 'Invocation id is already bound to a different request.',
      status: 409
    })
    expect(h.codecMint).not.toHaveBeenCalled()
    expect(h.minted).toEqual([])
  })

  it('does not reveal an invocation id owned by another delegation', async () => {
    const h = harness()
    h.state.existingInvocation = invocation({
      status: 'issued',
      delegationId: '99999999-9999-4999-8999-999999999999'
    })

    expect(await h.service.mintInvocation(mintInput())).toEqual(DELEGATION_DENIED)
    expect(h.codecMint).not.toHaveBeenCalled()
  })

  it.each([
    [
      'another delegation',
      invocation({
        status: 'issued',
        delegationId: '99999999-9999-4999-8999-999999999999'
      }),
      DELEGATION_DENIED
    ],
    [
      'a changed request in this delegation',
      invocation({ status: 'issued', requestHash: 'b'.repeat(64) }),
      {
        kind: 'conflict',
        code: 'INVOCATION_CONFLICT',
        message: 'Invocation id is already bound to a different request.',
        status: 409
      }
    ]
  ])('re-reads and safely classifies a concurrent conflict for %s', async (_name, winner, expected) => {
    const h = harness()
    h.deps.invocations.get.mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    h.deps.invocations.mint.mockResolvedValueOnce({ kind: 'conflict' })

    expect(await h.service.mintInvocation(mintInput())).toEqual(expected)
  })

  it.each([
    ['id', { id: 'wrong' }],
    ['delegation', { delegationId: '99999999-9999-4999-8999-999999999999' }],
    ['request', { requestHash: 'b'.repeat(64) }],
    ['method', { method: 'tools/call', toolName: CURATED_TOOL }],
    ['assertion hash', { assertionHash: 'wrong-hash' }],
    ['status', { status: 'running' as const }],
    ['expiry', { assertionExpires: new Date(NOW + 29_999) }]
  ])('rejects a malformed issued persistence result with wrong %s', async (_name, patch) => {
    const h = harness()
    h.deps.invocations.mint.mockImplementationOnce(async (input) => ({
      kind: 'issued',
      invocation: { ...invocationFromMint(input), ...patch }
    }))

    const result = await h.service.mintInvocation(mintInput())

    expect(result).toEqual(DELEGATION_DENIED)
    expect(JSON.stringify(result)).not.toMatch(/ac_mcp_assert_v1_/)
  })

  it.each(['running', 'succeeded', 'failed', 'ambiguous'] as const)(
    'returns only status for an identical %s retry and never mints plaintext',
    async (status) => {
      const h = harness()
      h.state.existingInvocation = invocation({ status })

      const result = await h.service.mintInvocation(mintInput())

      expect(result).toEqual({ kind: 'existing', invocationId: INVOCATION_ID, status })
      expect(Object.keys(result)).toEqual(['kind', 'invocationId', 'status'])
      expect(h.codecMint).not.toHaveBeenCalled()
      expect(h.minted).toEqual([])
    }
  )

  it.each(['denied', 'conflict'] as const)(
    'maps a persistence %s without returning the generated assertion',
    async (kind) => {
      const h = harness()
      h.deps.invocations.mint.mockResolvedValueOnce({ kind })
      if (kind === 'conflict') {
        h.deps.invocations.get
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(invocation({ status: 'issued', requestHash: 'b'.repeat(64) }))
      }

      const result = await h.service.mintInvocation(mintInput())

      expect(result).toEqual(
        kind === 'denied'
          ? DELEGATION_DENIED
          : {
              kind: 'conflict',
              code: 'INVOCATION_CONFLICT',
              message: 'Invocation id is already bound to a different request.',
              status: 409
            }
      )
      expect(JSON.stringify(result)).not.toMatch(/ac_mcp_assert_v1_/)
    }
  )
})
