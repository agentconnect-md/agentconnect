import { describe, expect, it } from 'vitest'
import {
  INSTALL_WIDE_FRAME_TYPES,
  REPO_CANDIDATE_DESCRIPTION_MAX,
  REPO_CANDIDATES_MAX,
  REPO_CANDIDATES_V1_FEATURE,
  RepoCandidatesReply,
  RepoCandidatesRequest,
  buildEnvelope,
  decodeEnvelope,
  encode,
  isFrame,
  isFrameType
} from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CORR_ID = '22222222-2222-4222-8222-222222222222'
const candidate = { provider: 'github', repoFullName: 'example-org/example-repo', repoId: '12345' }

describe('repo-candidates frames (multi-repository-workspaces.md, The selector)', () => {
  it('names one agent and answers bounded candidates with a partial flag', () => {
    expect(RepoCandidatesRequest.parse({ agentId: AGENT_ID })).toEqual({ agentId: AGENT_ID })
    expect(RepoCandidatesRequest.safeParse({ agentId: 'not-a-uuid' }).success).toBe(false)
    const full = { ...candidate, description: 'Shared build tooling', pushedAt: '2026-09-01T12:00:00.000Z' }
    expect(RepoCandidatesReply.parse({ candidates: [full, candidate], partial: false })).toEqual({
      candidates: [full, candidate],
      partial: false
    })
    expect(RepoCandidatesReply.safeParse({ candidates: [] }).success).toBe(false)
  })

  it('keeps description and pushed-at optional, and absent ones stay absent', () => {
    const parsed = RepoCandidatesReply.parse({ candidates: [candidate], partial: true })
    expect(parsed.candidates[0]).toEqual(candidate)
    expect(parsed.candidates[0]).not.toHaveProperty('description')
    expect(parsed.candidates[0]).not.toHaveProperty('pushedAt')
  })

  it('refuses more than the bound, a non-decimal id, an overlong description, and a bare date', () => {
    const many = Array.from({ length: REPO_CANDIDATES_MAX + 1 }, (_, i) => ({ ...candidate, repoId: String(i + 1) }))
    expect(RepoCandidatesReply.safeParse({ candidates: many.slice(0, -1), partial: true }).success).toBe(true)
    expect(RepoCandidatesReply.safeParse({ candidates: many, partial: true }).success).toBe(false)
    const reply = (entry: Record<string, unknown>) => ({ candidates: [{ ...candidate, ...entry }], partial: false })
    expect(RepoCandidatesReply.safeParse(reply({ repoId: 'r1' })).success).toBe(false)
    expect(
      RepoCandidatesReply.safeParse(reply({ description: 'x'.repeat(REPO_CANDIDATE_DESCRIPTION_MAX + 1) })).success
    ).toBe(false)
    expect(RepoCandidatesReply.safeParse(reply({ pushedAt: '2026-09-01' })).success).toBe(false)
  })

  it('strips a key a newer peer adds instead of refusing the frame', () => {
    const parsed = RepoCandidatesReply.parse({ candidates: [{ ...candidate, stars: 3 }], partial: false, ttl: 1 })
    expect(parsed).toEqual({ candidates: [candidate], partial: false })
  })

  it('round-trips the request and its correlated reply through the envelope', () => {
    const request = decodeEnvelope(encode(buildEnvelope('repo-candidates/request', { agentId: AGENT_ID })))
    if (!request.ok || !isFrame('repo-candidates/request')(request.frame)) throw new Error('expected a request')
    expect(request.frame.payload).toEqual({ agentId: AGENT_ID })
    const payload = { candidates: [candidate], partial: false }
    const reply = decodeEnvelope(encode(buildEnvelope('repo-candidates/reply', payload, { corr: CORR_ID })))
    if (!reply.ok || !isFrame('repo-candidates/reply')(reply.frame)) throw new Error('expected a reply')
    expect(reply.frame.payload).toEqual(payload)
    expect(reply.frame.corr).toBe(CORR_ID)
  })

  it('registers both frames as org-scoped members behind their own feature', () => {
    expect(REPO_CANDIDATES_V1_FEATURE).toBe('repo-candidates-v1')
    for (const type of ['repo-candidates/request', 'repo-candidates/reply']) {
      expect(isFrameType(type)).toBe(true)
      expect(INSTALL_WIDE_FRAME_TYPES.has(type as never)).toBe(false)
    }
  })
})
