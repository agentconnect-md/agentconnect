import { describe, expect, it } from 'vitest'
import { GitCredGrant, GitCredRequest } from '../index.js'

const AGENT_ID = '22222222-2222-4222-8222-222222222222'

const v1Request = { agentId: AGENT_ID, reason: 'clone' as const }
const v1Grant = {
  username: 'x-access-token',
  token: 'ghs_example',
  ttlSec: 3540,
  expiresAt: '2026-07-07T00:59:00.000Z',
  repoFullName: 'acme/infra',
  access: 'write' as const
}

describe('gitcred v2 (gitlab-com-integration.md §17.1)', () => {
  it('keeps the pre-v2 wire byte-identical: absent provider means GitHub v1', () => {
    expect(GitCredRequest.safeParse(v1Request).success).toBe(true)
    expect(GitCredGrant.safeParse(v1Grant).success).toBe(true)
  })

  it('carries provider-qualified identity on negotiated v2 frames', () => {
    const req = { ...v1Request, provider: 'gitlab', externalRepoId: '4455667' }
    expect(GitCredRequest.safeParse(req).success).toBe(true)
    const grant = GitCredGrant.safeParse({
      ...v1Grant,
      username: 'example-bot',
      repoFullName: 'example-group/sub/example-project',
      provider: 'gitlab',
      externalRepoId: '4455667',
      credentialEpoch: '3',
      providerExpiresAt: '2026-10-05T00:00:00.000Z'
    })
    expect(grant.success).toBe(true)
  })

  it('rejects non-numeric external ids and an empty username', () => {
    expect(GitCredRequest.safeParse({ ...v1Request, externalRepoId: 'example/project' }).success).toBe(false)
    expect(GitCredGrant.safeParse({ ...v1Grant, username: '' }).success).toBe(false)
  })

  it('keeps the GitHub username fence: provider-absent and github grants pin the literal', () => {
    expect(GitCredGrant.safeParse({ ...v1Grant, username: 'oauth2' }).success).toBe(false)
    expect(GitCredGrant.safeParse({ ...v1Grant, provider: 'github', username: 'oauth2' }).success).toBe(false)
    expect(GitCredGrant.safeParse({ ...v1Grant, provider: 'github' }).success).toBe(true)
  })

  it('accepts the broker effect purpose and keeps comment-level authority on gitlab grants only', () => {
    expect(GitCredRequest.safeParse({ ...v1Request, purpose: 'gitlab_effect' }).success).toBe(true)
    expect(GitCredRequest.safeParse({ ...v1Request, purpose: 'gitlab_broker' }).success).toBe(false)
    const commentGrant = {
      ...v1Grant,
      username: 'example-bot',
      access: 'comment' as const,
      provider: 'gitlab',
      externalRepoId: '4455667'
    }
    expect(GitCredGrant.safeParse(commentGrant).success).toBe(true)
    expect(GitCredGrant.safeParse({ ...v1Grant, access: 'comment' }).success).toBe(false)
    expect(GitCredGrant.safeParse({ ...commentGrant, provider: 'github', username: 'x-access-token' }).success).toBe(
      false
    )
  })
})
