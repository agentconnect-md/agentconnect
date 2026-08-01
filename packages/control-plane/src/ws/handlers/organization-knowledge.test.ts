import { describe, expect, it, vi } from 'vitest'
import {
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE,
  type AnyFrame
} from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import {
  handleKnowledgeSearch,
  handleManagedSkillRead,
  handleOrganizationSuggestionsSync
} from './organization-knowledge.js'

const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREIGN_AGENT = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG = 'org-default'
const SKILL = '51515151-5151-4515-8515-515151515151'

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
  get: async () => ({
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
      agent: { get: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON }) },
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
        agent: { get: async () => requester },
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
        get: async () => ({
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
})

describe('handleManagedSkillRead', () => {
  it('returns a bounded immutable archive slice only to an agent with the skill enabled', async () => {
    const archive = new Uint8Array([0, 1, 2, 3, 4, 5])
    const deps = {
      registry: featureRegistry,
      agent: { get: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON, managedSkills: [SKILL] }) },
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
      agent: { get: async () => ({ id: AGENT, orgId: ORG, daemonId: DAEMON, managedSkills: [] }) },
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
      registry: { get: async () => ({ id: DAEMON, orgId: ORG, capabilities: { features: [] } }) },
      agent: { get: vi.fn() },
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
    expect(deps.agent.get).not.toHaveBeenCalled()
  })
})

function randomUuid(): string {
  return crypto.randomUUID()
}
