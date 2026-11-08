import { describe, expect, it, vi } from 'vitest'
import type { SocialAccount } from '../github/logto-identity.js'
import type { GitlabConnectionRecord } from '../persistence/ports.js'
import { resolveCommitAuthors, type CommitAuthorsDeps } from './commit-authors.js'

const VIEWER = { orgId: 'org-1', userId: 'user-1' }
const GITHUB = {
  provider: 'github' as const,
  host: 'github.com',
  name: 'alex',
  email: '123+alex@users.noreply.github.com'
}
const CONNECTION = {
  id: 'connection-1',
  userId: VIEWER.userId,
  state: 'connected',
  gitlabUserId: 42n
} as GitlabConnectionRecord

function gitlab() {
  return {
    host: 'gitlab.example.test',
    connections: { listForOrg: vi.fn(async () => [CONNECTION]) },
    currentUser: vi.fn(async () => ({
      id: 42,
      username: 'alex-lab',
      commit_email: 'alex@users.noreply.example.test',
      public_email: ''
    }))
  }
}

describe('linked commit authors', () => {
  it.each([
    {
      identities: [
        { target: 'github', userId: '123', profileUrl: 'https://github.com/alex', email: 'private@example.test' }
      ]
    },
    { identities: [], githubRepoIdentity: { githubUserId: '123', login: 'alex' } }
  ])('uses a linked GitHub identity with its noreply address', async (linked) => {
    const account: SocialAccount = { ...linked, hasSecurityVerificationMethod: true }
    expect(await resolveCommitAuthors(VIEWER, { githubAccount: async () => account })).toEqual([GITHUB])
  })

  it('does not guess an identity from an email or fall back past an incomplete social link', async () => {
    expect(
      await resolveCommitAuthors(VIEWER, {
        githubAccount: async () => ({
          identities: [{ target: 'github', userId: '123', email: 'private@example.test' }],
          githubRepoIdentity: { githubUserId: '456', login: 'other-person' },
          hasSecurityVerificationMethod: true
        })
      })
    ).toEqual([])
  })

  it('uses the authenticated GitLab user behind this console member and instance', async () => {
    const source = gitlab()
    source.connections.listForOrg.mockResolvedValue([
      { ...CONNECTION, id: 'someone-else', userId: 'other-user' },
      CONNECTION
    ])
    expect(await resolveCommitAuthors(VIEWER, { gitlab: source })).toEqual([
      { provider: 'gitlab' as const, host: source.host, name: 'alex-lab', email: 'alex@users.noreply.example.test' }
    ])
    expect(source.currentUser).toHaveBeenCalledWith(VIEWER.orgId, CONNECTION.id)
  })

  it('omits ambiguous or mismatched GitLab accounts and never substitutes a private profile email', async () => {
    const source = gitlab()
    source.connections.listForOrg.mockResolvedValue([CONNECTION, { ...CONNECTION, id: 'second' }])
    expect(await resolveCommitAuthors(VIEWER, { gitlab: source })).toEqual([])
    expect(source.currentUser).not.toHaveBeenCalled()
    source.connections.listForOrg.mockResolvedValue([CONNECTION])
    source.currentUser.mockResolvedValue({
      id: 99,
      username: 'other',
      commit_email: 'other@example.test',
      public_email: ''
    })
    expect(await resolveCommitAuthors(VIEWER, { gitlab: source })).toEqual([])
    source.currentUser.mockResolvedValue({ id: 42, username: 'alex-lab', commit_email: '', public_email: '' })
    expect(await resolveCommitAuthors(VIEWER, { gitlab: source })).toEqual([])
  })

  it('keeps available identities when another provider fails and rejects multiline trailer data', async () => {
    const deps: CommitAuthorsDeps = {
      githubAccount: async () => ({
        identities: [],
        githubRepoIdentity: { githubUserId: '123', login: 'alex' },
        hasSecurityVerificationMethod: true
      }),
      gitlab: {
        ...gitlab(),
        currentUser: async () => {
          throw new Error('provider unavailable')
        }
      }
    }
    expect(await resolveCommitAuthors(VIEWER, deps)).toEqual([GITHUB])
    deps.gitlab!.currentUser = async () => ({
      id: 42,
      username: 'alex\nSigned-off-by: other',
      public_email: 'alex@example.test'
    })
    expect(await resolveCommitAuthors(VIEWER, deps)).toEqual([GITHUB])
  })
})
