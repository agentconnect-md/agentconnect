import { describe, expect, it, vi } from 'vitest'
import { DELEGATED_MCP_ASSERTION_FEATURE } from '@agentconnect.md/protocol'
import { MCP_TOOLS } from '../http/mcp/tools.js'
import type {
  EstablishWebchatMcpDelegationInput,
  McpInvocationRecord,
  MintMcpInvocationInput,
  WebchatMcpDelegationRecord
} from '../persistence/ports.js'
import { InvocationAssertionCodec } from './invocationAssertion.js'
import {
  DELEGATION_DENIED,
  MCP_INVOCATION_ASSERTION_TTL_MS,
  WEBCHAT_MCP_DELEGATION_DEFAULT_TTL_MS,
  WebchatMcpDelegationService,
  type DelegationDenialReason,
  type MintInvocationInput
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

function harness() {
  const state = {
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
  const established: EstablishWebchatMcpDelegationInput[] = []
  const minted: MintMcpInvocationInput[] = []
  const codec = new InvocationAssertionCodec('test-pepper-that-is-at-least-thirty-two-characters')
  const codecMint = vi.spyOn(codec, 'mint')
  const deps = {
    clock: { now: () => NOW },
    assertionCodec: codec,
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
    orgs: { roleOf: vi.fn(async () => state.role) },
    agents: { get: vi.fn(async () => state.agent) },
    presets: {
      get: vi.fn(async () =>
        state.presetAgentId === null
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
    daemons: { get: vi.fn(() => state.live) },
    delegations: {
      establish: vi.fn(async (input: EstablishWebchatMcpDelegationInput) => {
        established.push(input)
        return state.delegation
      }),
      get: vi.fn(async () => state.delegation)
    },
    invocations: {
      get: vi.fn(async () => state.existingInvocation),
      mint: vi.fn(async (input: MintMcpInvocationInput) => {
        minted.push(input)
        return { kind: 'issued' as const, invocation: invocation({ assertionHash: input.assertionHash }) }
      })
    },
    onDenied: (reason: DelegationDenialReason) => reasons.push(reason)
  }
  return {
    state,
    reasons,
    established,
    minted,
    codec,
    codecMint,
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

describe('WebchatMcpDelegationService.establish', () => {
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

    await h.service.establish({ ...establishInput(), sessionExpiresAt })

    expect(h.established[0]?.expiresAt).toEqual(sessionExpiresAt)
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
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({ ...input, method: 'resources/list' })
    ],
    [
      'tools/list with a tool name',
      (_h: ReturnType<typeof harness>, input: MintInvocationInput) => ({ ...input, toolName: MCP_TOOLS[0]!.name })
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
      toolName: MCP_TOOLS[0]!.name
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
      toolName: MCP_TOOLS[0]!.name,
      assertionExpires: new Date(NOW + 30_000),
      now: new Date(NOW)
    })
    expect(JSON.stringify(h.minted[0])).not.toContain(result.assertion)
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
