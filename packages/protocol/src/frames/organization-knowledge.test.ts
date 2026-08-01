import { describe, expect, it } from 'vitest'
import {
  AgentSpec,
  DreamSkillContent,
  KnowledgeSearchReq,
  MAX_FRAME_BYTES,
  ManagedSkillChunk,
  ORGANIZATION_SUGGESTION_CHUNK_BYTES,
  OrganizationSuggestionChunk,
  OrganizationSuggestionContent,
  OrganizationSuggestionsSyncReq,
  buildEnvelope,
  decodeEnvelope,
  isFrame,
  organizationSuggestionCanonical
} from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222'
const SKILL_ID = '33333333-3333-4333-8333-333333333333'
const DIGEST = `sha256:${'a'.repeat(64)}`

describe('organization knowledge protocol', () => {
  it('defaults and bounds the trusted-agent knowledge search request', () => {
    expect(KnowledgeSearchReq.parse({ requesterAgentId: AGENT_ID, query: 'release process' })).toEqual({
      requesterAgentId: AGENT_ID,
      query: 'release process',
      limit: 5,
      maxBytes: 8192
    })
    expect(
      KnowledgeSearchReq.safeParse({ requesterAgentId: AGENT_ID, query: 'x', limit: 11, maxBytes: 8192 }).success
    ).toBe(false)
    expect(KnowledgeSearchReq.safeParse({ requesterAgentId: AGENT_ID, query: '   ' }).success).toBe(false)
  })

  it('accepts a bounded sync inventory and rejects non-uuid candidate identity', () => {
    const candidate = {
      sourceAgentId: AGENT_ID,
      dreamId: 'drm-1',
      candidateId: CANDIDATE_ID,
      kind: 'knowledge' as const,
      operation: 'create' as const,
      title: 'Release process',
      digest: DIGEST,
      contentBytes: 120,
      state: 'proposed' as const,
      sessionIds: ['s1'],
      createdAt: '2026-07-31T00:00:00.000Z'
    }
    expect(OrganizationSuggestionsSyncReq.safeParse({ suggestions: [candidate] }).success).toBe(true)
    expect(
      OrganizationSuggestionsSyncReq.safeParse({ suggestions: [{ ...candidate, candidateId: 'model-picked' }] }).success
    ).toBe(false)
    expect(OrganizationSuggestionsSyncReq.safeParse({ suggestions: [{ ...candidate, contentBytes: 0 }] }).success).toBe(
      false
    )
  })

  it('carries a complete skill directory tree, not only a scripts list', () => {
    const content = OrganizationSuggestionContent.parse({
      sourceAgentId: AGENT_ID,
      dreamId: 'drm-1',
      candidateId: CANDIDATE_ID,
      digest: DIGEST,
      exists: true,
      body: {
        kind: 'skill',
        files: [
          { path: 'SKILL.md', content: '---\nname: release-service\ndescription: Release safely\n---\n' },
          { path: 'references/runbook.md', content: '# Runbook' }
        ]
      }
    })
    expect(content.body?.kind).toBe('skill')
    if (content.body?.kind !== 'skill') throw new Error('expected skill content')
    expect(content.body.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/runbook.md'])
  })

  it('chunks pending suggestion bodies below the control-wire frame ceiling', () => {
    const payload = OrganizationSuggestionChunk.parse({
      sourceAgentId: AGENT_ID,
      dreamId: 'drm-1',
      candidateId: CANDIDATE_ID,
      digest: DIGEST,
      exists: true,
      size: ORGANIZATION_SUGGESTION_CHUNK_BYTES,
      offset: 0,
      nextOffset: ORGANIZATION_SUGGESTION_CHUNK_BYTES,
      data: Buffer.alloc(ORGANIZATION_SUGGESTION_CHUNK_BYTES).toString('base64'),
      truncated: false
    })
    expect(
      Buffer.byteLength(JSON.stringify(buildEnvelope('knowledge/suggestion/content', payload)))
    ).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    expect(OrganizationSuggestionChunk.safeParse({ ...payload, truncated: true }).success).toBe(false)
    expect(
      OrganizationSuggestionChunk.safeParse({
        ...payload,
        size: 1,
        offset: 2,
        nextOffset: 2,
        data: '',
        truncated: false
      }).success
    ).toBe(false)
  })

  it('keeps accepted skill bodies out of AgentSpec and transfers them as bounded chunks', () => {
    const spec = AgentSpec.parse({
      name: 'release-agent',
      managedSkills: [{ id: SKILL_ID, name: 'release-service', revision: 2, digest: DIGEST }]
    })
    expect(spec.managedSkills).toEqual([{ id: SKILL_ID, name: 'release-service', revision: 2, digest: DIGEST }])

    expect(
      ManagedSkillChunk.safeParse({
        managedSkillId: SKILL_ID,
        revision: 2,
        digest: DIGEST,
        size: 3,
        offset: 0,
        nextOffset: 3,
        data: 'eGlw',
        truncated: false
      }).success
    ).toBe(true)

    expect(
      ManagedSkillChunk.safeParse({
        managedSkillId: SKILL_ID,
        revision: 2,
        digest: DIGEST,
        size: 3,
        offset: 0,
        nextOffset: 3,
        data: 'eGlw',
        truncated: true
      }).success
    ).toBe(false)
    expect(
      ManagedSkillChunk.safeParse({
        managedSkillId: SKILL_ID,
        revision: 2,
        digest: DIGEST,
        size: 3,
        offset: 4,
        nextOffset: 4,
        data: '',
        truncated: false
      }).success
    ).toBe(false)
  })

  it('bounds and deduplicates managed skill bindings in AgentSpec', () => {
    expect(
      AgentSpec.safeParse({
        name: 'duplicate-bindings',
        managedSkills: [
          { id: SKILL_ID, name: 'release-service', revision: 1, digest: DIGEST },
          { id: SKILL_ID, name: 'release-service', revision: 2, digest: DIGEST }
        ]
      }).success
    ).toBe(false)
    expect(
      AgentSpec.safeParse({
        name: 'too-many-bindings',
        managedSkills: Array.from({ length: 65 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          name: `skill-${index}`,
          revision: 1,
          digest: DIGEST
        }))
      }).success
    ).toBe(false)
  })

  it('uses locale-independent code-point ordering for candidate digests', () => {
    expect(
      organizationSuggestionCanonical({
        kind: 'skill',
        files: [
          { path: 'ä.md', encoding: 'utf8', content: 'umlaut' },
          { path: 'z.md', encoding: 'utf8', content: 'latin' }
        ]
      })
    ).toBe(
      '{"kind":"skill","files":[{"path":"z.md","encoding":"utf8","content":"latin"},{"path":"ä.md","encoding":"utf8","content":"umlaut"}]}'
    )
  })

  it('keeps agent-local Dream skill review responses below their legacy wire budget', () => {
    expect(
      DreamSkillContent.safeParse({
        agentId: AGENT_ID,
        dreamId: 'drm-1',
        name: 'release-service',
        exists: true,
        skill: '# Release',
        scripts: [{ path: 'run.sh', content: 'echo ready' }]
      }).success
    ).toBe(true)
    expect(
      DreamSkillContent.safeParse({
        agentId: AGENT_ID,
        dreamId: 'drm-1',
        name: 'release-service',
        exists: true,
        skill: '# Release',
        files: [{ path: 'references/runbook.md', content: 'x' }]
      }).success
    ).toBe(false)
    expect(
      DreamSkillContent.safeParse({
        agentId: AGENT_ID,
        dreamId: 'drm-1',
        name: 'release-service',
        exists: true,
        skill: 'x'.repeat(16_001)
      }).success
    ).toBe(false)
  })

  it('round-trips the new search frame through the shared codec', () => {
    const encoded = JSON.stringify(
      buildEnvelope('knowledge/search', { requesterAgentId: AGENT_ID, query: 'release', limit: 3, maxBytes: 4096 })
    )
    const decoded = decodeEnvelope(encoded)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('knowledge/search')(decoded.frame)) throw new Error('expected knowledge/search')
    expect(decoded.frame.payload.requesterAgentId).toBe(AGENT_ID)
  })
})
