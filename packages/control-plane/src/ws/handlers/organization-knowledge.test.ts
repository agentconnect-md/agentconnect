import { describe, expect, it, vi } from 'vitest'
import {
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE,
  type AnyFrame
} from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { PlacementResolver } from '../../orchestrator/placementResolver.js'
import { systemClock } from '../../domain/clock.js'
import type { DaemonId } from '../../domain/ids.js'
import {
  handleKnowledgeSearch,
  handleKnowledgeList,
  handleOrgSkills,
  handleManagedSkillRead,
  handleOrganizationSuggestionsSync
} from './organization-knowledge.js'

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREIGN_AGENT = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'org-default'
const SKILL = '51515151-5151-4515-8515-515151515151'
const ORG_A = 'org-a'
const ORG_B = 'org-b'

const POOL_SET = '5e700000-0000-4000-8000-000000000001'

const installWideCapabilities = {
  features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
}

/** A pool row: placed on the org-less set, naming no machine. `agent.daemonId` can never
 *  authorize one. */
function poolAgent(id: string) {
  return { id, placementKind: 'set' as const, daemonId: null, setId: POOL_SET }
}

/** The live seam, keyed by who holds each agent's duty right now. */
function holderOf(holds: Record<string, string[]>): PlacementResolver {
  const of = async (agentId: string) => (holds[String(agentId)] ?? []) as DaemonId[]
  return new PlacementResolver({ duties: { holdersOf: of, confirmedHoldersOf: of }, clock: systemClock })
}

function proposed(sourceAgentId: string) {
  return {
    sourceAgentId,
    dreamId: `dream-${sourceAgentId.slice(0, 4)}`,
    candidateId: '33333333-3333-4333-8333-333333333333',
    kind: 'knowledge',
    operation: 'create',
    title: 'Candidate',
    digest: `sha256:${'a'.repeat(64)}`,
    contentBytes: 10,
    state: 'proposed',
    sessionIds: ['session-1'],
    createdAt: '2026-08-01T00:00:00.000Z'
  }
}

function frame(type: AnyFrame['type'], payload: Record<string, unknown>): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-31T00:00:00.000Z',
    type,
    payload
  } as AnyFrame
}

function conn() {
  return {
    daemonId: DAEMON,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
    sendError: ReturnType<typeof vi.fn>
  }
}

const featureRegistry = {
  getUnscoped: async () => ({
    id: DAEMON,
    orgId: ORG,
    capabilities: { features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE] }
  })
}

describe('handleKnowledgeSearch', () => {
  it('derives tenancy from a requester placed on the connection and truncates only on a UTF-8 boundary', async () => {
    const searchKnowledge = vi.fn(async () => [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Unicode',
        summary: null,
        tags: ['guide'],
        currentRevision: 2,
        updatedAt: new Date('2026-07-31T01:00:00.000Z'),
        content: 'ééé'
      }
    ])
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON }) },
      organizationKnowledge: { searchKnowledge }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleKnowledgeSearch(
      frame('knowledge/search', { requesterAgentId: AGENT, query: 'unicode', limit: 5, maxBytes: 5 }),
      connection,
      deps
    )

    expect(searchKnowledge).toHaveBeenCalledWith(ORG, { query: 'unicode', limit: 5 })
    expect(connection.replyTo.mock.calls[0]![1]).toBe('knowledge/search/ok')
    expect(connection.replyTo.mock.calls[0]![2]).toEqual({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Unicode',
          summary: null,
          tags: ['guide'],
          revision: 2,
          updatedAt: '2026-07-31T01:00:00.000Z',
          content: 'éé',
          truncated: true
        }
      ]
    })
  })

  it('fails closed when the requester is unknown or placed on another daemon', async () => {
    for (const requester of [null, { id: AGENT, orgId: ORG, daemonId: 'another-daemon' }]) {
      const searchKnowledge = vi.fn()
      const deps = {
        registry: featureRegistry,
        agent: { getUnscoped: async () => requester },
        organizationKnowledge: { searchKnowledge }
      } as unknown as DaemonWsDeps
      const connection = conn()
      await handleKnowledgeSearch(
        frame('knowledge/search', { requesterAgentId: AGENT, query: 'secret', limit: 5, maxBytes: 1024 }),
        connection,
        deps
      )
      expect(connection.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
      expect(searchKnowledge).not.toHaveBeenCalled()
    }
  })
})

describe('handleKnowledgeList', () => {
  it('lists org knowledge (query-less), org-scoped from the placed requester', async () => {
    const listKnowledge = vi.fn(async () => [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Release',
        summary: 'How releases work',
        tags: ['release'],
        currentRevision: 3,
        updatedAt: new Date('2026-07-31T01:00:00.000Z'),
        content: 'body'
      }
    ])
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON }) },
      organizationKnowledge: { listKnowledge }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleKnowledgeList(
      frame('knowledge/list', { requesterAgentId: AGENT, limit: 10, maxBytes: 8192 }),
      connection,
      deps
    )

    expect(listKnowledge).toHaveBeenCalledWith(ORG, false)
    expect(connection.replyTo.mock.calls[0]![1]).toBe('knowledge/list/ok')
    expect(connection.replyTo.mock.calls[0]![2]).toEqual({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Release',
          summary: 'How releases work',
          tags: ['release'],
          revision: 3,
          updatedAt: '2026-07-31T01:00:00.000Z',
          content: 'body',
          truncated: false
        }
      ]
    })
  })

  it('fails closed when the requester is placed on another daemon', async () => {
    const listKnowledge = vi.fn()
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: 'another-daemon' }) },
      organizationKnowledge: { listKnowledge }
    } as unknown as DaemonWsDeps
    const connection = conn()
    await handleKnowledgeList(
      frame('knowledge/list', { requesterAgentId: AGENT, limit: 10, maxBytes: 8192 }),
      connection,
      deps
    )
    expect(connection.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    expect(listKnowledge).not.toHaveBeenCalled()
  })

  it('requires ALL requested tags (AND), matching the tool contract', async () => {
    const listKnowledge = vi.fn(async () => [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Both',
        summary: null,
        tags: ['release', 'infra'],
        currentRevision: 1,
        updatedAt: new Date('2026-07-31T01:00:00.000Z'),
        content: 'a'
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'One',
        summary: null,
        tags: ['release'],
        currentRevision: 1,
        updatedAt: new Date('2026-07-31T01:00:00.000Z'),
        content: 'b'
      }
    ])
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON }) },
      organizationKnowledge: { listKnowledge }
    } as unknown as DaemonWsDeps
    const connection = conn()
    await handleKnowledgeList(
      frame('knowledge/list', { requesterAgentId: AGENT, limit: 10, maxBytes: 8192, tags: ['release', 'infra'] }),
      connection,
      deps
    )
    const items = connection.replyTo.mock.calls[0]![2].items as { id: string }[]
    expect(items.map((i) => i.id)).toEqual(['11111111-1111-4111-8111-111111111111']) // "One" (missing infra) excluded
  })
})

describe('handleOrgSkills', () => {
  const rows = [
    {
      id: SKILL,
      orgId: ORG,
      name: 'release-service',
      description: 'Release with rollback',
      currentRevision: 2,
      updatedAt: new Date('2026-07-31T01:00:00.000Z')
    },
    {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      orgId: ORG,
      name: 'triage-issues',
      description: 'Triage inbound issues',
      currentRevision: 1,
      updatedAt: new Date('2026-07-31T02:00:00.000Z')
    }
  ]

  it('lists accepted org skills (metadata only) when no query is given', async () => {
    const listManagedSkills = vi.fn(async () => rows)
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON }) },
      organizationKnowledge: { listManagedSkills }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleOrgSkills(frame('skills/org', { requesterAgentId: AGENT, limit: 20 }), connection, deps)

    expect(listManagedSkills).toHaveBeenCalledWith(ORG, false)
    expect(connection.replyTo.mock.calls[0]![1]).toBe('skills/org/ok')
    expect(connection.replyTo.mock.calls[0]![2]).toEqual({
      items: [
        {
          id: SKILL,
          name: 'release-service',
          description: 'Release with rollback',
          revision: 2,
          updatedAt: '2026-07-31T01:00:00.000Z'
        },
        {
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          name: 'triage-issues',
          description: 'Triage inbound issues',
          revision: 1,
          updatedAt: '2026-07-31T02:00:00.000Z'
        }
      ]
    })
  })

  it('filters by name/description when a query is given', async () => {
    const listManagedSkills = vi.fn(async () => rows)
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON }) },
      organizationKnowledge: { listManagedSkills }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleOrgSkills(
      frame('skills/org', { requesterAgentId: AGENT, query: 'triage', limit: 20 }),
      connection,
      deps
    )

    expect(connection.replyTo.mock.calls[0]![2]).toEqual({
      items: [
        {
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          name: 'triage-issues',
          description: 'Triage inbound issues',
          revision: 1,
          updatedAt: '2026-07-31T02:00:00.000Z'
        }
      ]
    })
  })
})

describe('handleOrganizationSuggestionsSync', () => {
  it('accepts only proposed candidates from agents currently placed on the sending daemon', async () => {
    const acceptedCandidate = '22222222-2222-4222-8222-222222222222'
    const syncSuggestions = vi.fn(async (_orgId, _daemonId, suggestions) => [
      {
        ...suggestions[0],
        id: 'suggestion-id',
        state: 'accepted'
      }
    ])
    const deps = {
      registry: featureRegistry,
      agent: {
        list: async () => [
          { id: AGENT, daemonId: DAEMON },
          { id: FOREIGN_AGENT, daemonId: 'another-daemon' }
        ]
      },
      organizationKnowledge: { syncSuggestions }
    } as unknown as DaemonWsDeps
    const connection = conn()
    const candidate = (sourceAgentId: string, candidateId: string, state: 'proposed' | 'accepted') => ({
      sourceAgentId,
      dreamId: 'dream-1',
      candidateId,
      kind: 'knowledge',
      operation: 'create',
      title: 'Candidate',
      digest: `sha256:${'a'.repeat(64)}`,
      contentBytes: 10,
      state,
      sessionIds: ['session-1'],
      createdAt: '2026-07-31T00:00:00.000Z'
    })

    await handleOrganizationSuggestionsSync(
      frame('knowledge/suggestions/sync', {
        suggestions: [
          candidate(AGENT, acceptedCandidate, 'proposed'),
          candidate(FOREIGN_AGENT, randomUuid(), 'proposed'),
          candidate(AGENT, randomUuid(), 'accepted')
        ]
      }),
      connection,
      deps
    )

    expect(syncSuggestions).toHaveBeenCalledWith(ORG, DAEMON, [candidate(AGENT, acceptedCandidate, 'proposed')])
    expect(connection.replyTo.mock.calls[0]![1]).toBe('knowledge/suggestions/sync/ok')
    expect(connection.replyTo.mock.calls[0]![2]).toEqual({
      decisions: [{ sourceAgentId: AGENT, dreamId: 'dream-1', candidateId: acceptedCandidate, state: 'accepted' }]
    })
  })

  it('keeps metadata convergent but withholds terminal decisions while staged review is held', async () => {
    const candidateId = '22222222-2222-4222-8222-222222222222'
    const syncSuggestions = vi.fn(async (_orgId, _daemonId, suggestions) => [
      { ...suggestions[0], id: 'suggestion-id', state: 'rejected' }
    ])
    const deps = {
      registry: {
        getUnscoped: async () => ({
          id: DAEMON,
          orgId: ORG,
          capabilities: { features: [ORGANIZATION_KNOWLEDGE_FEATURE] }
        })
      },
      agent: { list: async () => [{ id: AGENT, daemonId: DAEMON }] },
      organizationKnowledge: { syncSuggestions }
    } as unknown as DaemonWsDeps
    const connection = conn()
    const suggestion = {
      sourceAgentId: AGENT,
      dreamId: 'dream-held',
      candidateId,
      kind: 'knowledge',
      operation: 'create',
      title: 'Held candidate',
      digest: `sha256:${'a'.repeat(64)}`,
      contentBytes: 10,
      state: 'proposed',
      sessionIds: ['session-1'],
      createdAt: '2026-08-01T00:00:00.000Z'
    }

    await handleOrganizationSuggestionsSync(
      frame('knowledge/suggestions/sync', { suggestions: [suggestion] }),
      connection,
      deps
    )

    expect(syncSuggestions).toHaveBeenCalledWith(ORG, DAEMON, [suggestion])
    expect(connection.replyTo.mock.calls[0]![2]).toEqual({ decisions: [] })
  })

  // #968: a pool member is an org-less per-Pod record, so the connection has no org to derive —
  // and the agents it dreams for are pool rows naming no machine at all.
  it('records each org-scoped frame from one install-wide member under the org it names', async () => {
    const syncSuggestions = vi.fn(async (_orgId, _daemonId, suggestions) =>
      suggestions.map((s: { sourceAgentId: string }) => ({ ...s, id: 'suggestion-id', state: 'pending' }))
    )
    const byOrg: Record<string, ReturnType<typeof poolAgent>[]> = {
      [ORG_A]: [poolAgent(AGENT)],
      [ORG_B]: [poolAgent(FOREIGN_AGENT)]
    }
    const deps = {
      registry: { getUnscoped: async () => ({ id: DAEMON, orgId: null, capabilities: installWideCapabilities }) },
      agent: { list: async (orgId: string) => byOrg[orgId] ?? [] },
      placementResolver: holderOf({ [AGENT]: [DAEMON], [FOREIGN_AGENT]: [DAEMON] }),
      organizationKnowledge: { syncSuggestions }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleOrganizationSuggestionsSync(
      { ...frame('knowledge/suggestions/sync', { suggestions: [proposed(AGENT)] }), orgId: ORG_A },
      connection,
      deps
    )
    await handleOrganizationSuggestionsSync(
      { ...frame('knowledge/suggestions/sync', { suggestions: [proposed(FOREIGN_AGENT)] }), orgId: ORG_B },
      connection,
      deps
    )

    expect(connection.sendError).not.toHaveBeenCalled()
    expect(syncSuggestions).toHaveBeenNthCalledWith(1, ORG_A, DAEMON, [proposed(AGENT)])
    expect(syncSuggestions).toHaveBeenNthCalledWith(2, ORG_B, DAEMON, [proposed(FOREIGN_AGENT)])
  })

  it('refuses an org-scoped frame that names an org the sending agent is not in', async () => {
    const syncSuggestions = vi.fn(async () => [])
    const deps = {
      registry: { getUnscoped: async () => ({ id: DAEMON, orgId: null, capabilities: installWideCapabilities }) },
      agent: { list: async () => [] },
      placementResolver: holderOf({ [AGENT]: [DAEMON] }),
      organizationKnowledge: { syncSuggestions }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleOrganizationSuggestionsSync(
      { ...frame('knowledge/suggestions/sync', { suggestions: [proposed(AGENT)] }), orgId: ORG_B },
      connection,
      deps
    )

    // The allowed set is still the fence: an org that holds none of this member's agents records nothing.
    expect(syncSuggestions).toHaveBeenCalledWith(ORG_B, DAEMON, [])
  })

  it('refuses a pool agent this member holds no duty for', async () => {
    const syncSuggestions = vi.fn(async () => [])
    const deps = {
      registry: { getUnscoped: async () => ({ id: DAEMON, orgId: null, capabilities: installWideCapabilities }) },
      agent: { list: async () => [poolAgent(AGENT), poolAgent(FOREIGN_AGENT)] },
      // The foreign agent's duty is held by another member, so this connection may not report it.
      placementResolver: holderOf({ [AGENT]: [DAEMON], [FOREIGN_AGENT]: ['another-member'] }),
      organizationKnowledge: { syncSuggestions }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleOrganizationSuggestionsSync(
      {
        ...frame('knowledge/suggestions/sync', { suggestions: [proposed(AGENT), proposed(FOREIGN_AGENT)] }),
        orgId: ORG_A
      },
      connection,
      deps
    )

    expect(syncSuggestions).toHaveBeenCalledWith(ORG_A, DAEMON, [proposed(AGENT)])
  })

  it('refuses an unscoped frame from an install-wide member', async () => {
    const syncSuggestions = vi.fn(async () => [])
    const deps = {
      registry: { getUnscoped: async () => ({ id: DAEMON, orgId: null, capabilities: installWideCapabilities }) },
      agent: { list: async () => [poolAgent(AGENT)] },
      placementResolver: holderOf({ [AGENT]: [DAEMON] }),
      organizationKnowledge: { syncSuggestions }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleOrganizationSuggestionsSync(
      frame('knowledge/suggestions/sync', { suggestions: [proposed(AGENT)] }),
      connection,
      deps
    )

    expect(syncSuggestions).not.toHaveBeenCalled()
    expect(connection.sendError.mock.calls[0]![1]).toBe('SCOPE_DENIED')
  })
})

describe('handleManagedSkillRead', () => {
  it('returns a bounded immutable archive slice only to an agent with the skill enabled', async () => {
    const archive = new Uint8Array([0, 1, 2, 3, 4, 5])
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON, managedSkills: [SKILL] }) },
      organizationKnowledge: {
        getManagedSkill: async () => ({ id: SKILL, orgId: ORG, archivedAt: null }),
        getManagedSkillRevision: async () => ({
          managedSkillId: SKILL,
          revision: 3,
          archive,
          digest: `sha256:${'b'.repeat(64)}`
        })
      }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleManagedSkillRead(
      frame('managed-skill/read', {
        requesterAgentId: AGENT,
        managedSkillId: SKILL,
        revision: 3,
        offset: 2,
        limit: 2
      }),
      connection,
      deps
    )

    expect(connection.replyTo.mock.calls[0]![1]).toBe('managed-skill/chunk')
    expect(connection.replyTo.mock.calls[0]![2]).toEqual({
      managedSkillId: SKILL,
      revision: 3,
      digest: `sha256:${'b'.repeat(64)}`,
      size: 6,
      offset: 2,
      nextOffset: 4,
      data: Buffer.from([2, 3]).toString('base64'),
      truncated: true
    })
  })

  it('fails closed before reading content when the skill is not enabled for the requester', async () => {
    const getManagedSkillRevision = vi.fn()
    const deps = {
      registry: featureRegistry,
      agent: { getUnscoped: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON, managedSkills: [] }) },
      organizationKnowledge: { getManagedSkillRevision }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleManagedSkillRead(
      frame('managed-skill/read', {
        requesterAgentId: AGENT,
        managedSkillId: SKILL,
        revision: 1,
        offset: 0,
        limit: 1024
      }),
      connection,
      deps
    )

    expect(connection.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    expect(getManagedSkillRevision).not.toHaveBeenCalled()
  })

  it('refuses organization frames from a daemon that omitted the feature', async () => {
    const searchKnowledge = vi.fn()
    const deps = {
      registry: { getUnscoped: async () => ({ id: DAEMON, orgId: ORG, capabilities: { features: [] } }) },
      agent: { getUnscoped: vi.fn() },
      organizationKnowledge: { searchKnowledge }
    } as unknown as DaemonWsDeps
    const connection = conn()

    await handleKnowledgeSearch(
      frame('knowledge/search', { requesterAgentId: AGENT, query: 'secret', limit: 5, maxBytes: 1024 }),
      connection,
      deps
    )

    expect(connection.sendError).toHaveBeenCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    expect(searchKnowledge).not.toHaveBeenCalled()
    expect(deps.agent.getUnscoped).not.toHaveBeenCalled()
  })
})

// #999: the four organization READS on an install-wide member. A pool agent names no machine, so
// `agent.daemonId` refuses every read from the very member that runs it.
describe('organization reads follow the serving member', () => {
  const knowledgeRow = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Runbook',
    summary: null,
    tags: ['runbook'],
    currentRevision: 1,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    content: 'body'
  }

  /** A pool row with one managed skill enabled — the shape every read below asks about. */
  const poolRequester = (orgId = ORG_A) => ({ ...poolAgent(AGENT), orgId, managedSkills: [SKILL] })
  const machineRequester = () => ({
    id: AGENT,
    placementKind: 'daemon' as const,
    daemonId: DAEMON,
    orgId: ORG_A,
    managedSkills: [SKILL]
  })

  function knowledgeRepo() {
    return {
      searchKnowledge: vi.fn(async () => [knowledgeRow]),
      listKnowledge: vi.fn(async () => [knowledgeRow]),
      listManagedSkills: vi.fn(async () => [
        {
          id: SKILL,
          orgId: ORG_A,
          name: 'release-service',
          description: 'Release with rollback',
          currentRevision: 1,
          updatedAt: new Date('2026-08-01T00:00:00.000Z')
        }
      ]),
      getManagedSkill: vi.fn(async () => ({ id: SKILL, orgId: ORG_A, archivedAt: null })),
      getManagedSkillRevision: vi.fn(async () => ({
        managedSkillId: SKILL,
        revision: 1,
        archive: new Uint8Array([1, 2, 3, 4]),
        digest: `sha256:${'b'.repeat(64)}`
      }))
    }
  }

  const reads = [
    {
      type: 'knowledge/search' as const,
      ok: 'knowledge/search/ok',
      payload: { query: 'runbook', limit: 5, maxBytes: 1024 },
      probe: 'searchKnowledge' as const,
      handler: handleKnowledgeSearch
    },
    {
      type: 'knowledge/list' as const,
      ok: 'knowledge/list/ok',
      payload: { limit: 5, maxBytes: 1024 },
      probe: 'listKnowledge' as const,
      handler: handleKnowledgeList
    },
    {
      type: 'skills/org' as const,
      ok: 'skills/org/ok',
      payload: { limit: 5 },
      probe: 'listManagedSkills' as const,
      handler: handleOrgSkills
    },
    {
      type: 'managed-skill/read' as const,
      ok: 'managed-skill/chunk',
      payload: { managedSkillId: SKILL, revision: 1, offset: 0, limit: 1024 },
      probe: 'getManagedSkillRevision' as const,
      handler: handleManagedSkillRead
    }
  ]

  async function read(
    spec: (typeof reads)[number],
    requester: Record<string, unknown>,
    holds: Record<string, string[]>
  ) {
    const organizationKnowledge = knowledgeRepo()
    const deps = {
      // An install-wide member: org-less, so the frame is the only thing that names an org.
      registry: { getUnscoped: async () => ({ id: DAEMON, orgId: null, capabilities: installWideCapabilities }) },
      agent: { getUnscoped: async () => requester },
      placementResolver: holderOf(holds),
      organizationKnowledge
    } as unknown as DaemonWsDeps
    const connection = conn()
    await spec.handler(
      { ...frame(spec.type, { requesterAgentId: AGENT, ...spec.payload }), orgId: ORG_A },
      connection,
      deps
    )
    return { connection, organizationKnowledge }
  }

  for (const spec of reads) {
    it(`serves ${spec.type} for a pool agent whose duty this member holds`, async () => {
      const { connection, organizationKnowledge } = await read(spec, poolRequester(), { [AGENT]: [DAEMON] })

      expect(connection.sendError).not.toHaveBeenCalled()
      expect(connection.replyTo.mock.calls[0]![1]).toBe(spec.ok)
      expect(organizationKnowledge[spec.probe]).toHaveBeenCalled()
    })

    it(`refuses ${spec.type} for a pool agent another member holds`, async () => {
      const { connection, organizationKnowledge } = await read(spec, poolRequester(), { [AGENT]: ['another-member'] })

      expect(connection.replyTo).not.toHaveBeenCalled()
      expect(connection.sendError.mock.calls[0]![1]).toBe('SCOPE_DENIED')
      expect(organizationKnowledge[spec.probe]).not.toHaveBeenCalled()
    })

    it(`still serves ${spec.type} for an agent placed on this daemon`, async () => {
      const { connection, organizationKnowledge } = await read(spec, machineRequester(), {})

      expect(connection.sendError).not.toHaveBeenCalled()
      expect(connection.replyTo.mock.calls[0]![1]).toBe(spec.ok)
      expect(organizationKnowledge[spec.probe]).toHaveBeenCalled()
    })
  }

  it('refuses a read whose requester belongs to another organization', async () => {
    // Serving an agent is not standing in its org: the frame names ORG_A, the requester is in ORG_B.
    const { connection, organizationKnowledge } = await read(reads[0]!, poolRequester(ORG_B), { [AGENT]: [DAEMON] })

    expect(connection.sendError.mock.calls[0]![1]).toBe('SCOPE_DENIED')
    expect(organizationKnowledge.searchKnowledge).not.toHaveBeenCalled()
  })
})

function randomUuid(): string {
  return crypto.randomUUID()
}
