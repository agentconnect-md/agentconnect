import { describe, expect, it, vi } from 'vitest'
import type { SocialAccount } from '../github/logto-identity.js'
import type { AzureDevOpsConnectionRecord, GitlabConnectionRecord } from '../persistence/ports.js'
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
      commit_email: 'private@example.test',
      public_email: 'alex@users.noreply.example.test'
    }))
  }
}

describe('linked commit authors', () => {
  const microsoft = { target: 'azuread', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', email: 'alex@example.test' }
  const azureConnection = {
    id: 'azure-connection-1',
    orgId: VIEWER.orgId,
    tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    organization: 'example-org',
    state: 'connected',
    createdByUserId: 'another-installer'
  } as AzureDevOpsConnectionRecord
  const azureSource = () => ({
    connections: { listForOrg: vi.fn(async () => [azureConnection]) },
    userFor: vi.fn(async (): Promise<{ name: string; email: string } | null> => ({
      name: 'Alex Example',
      email: microsoft.email
    }))
  })

  it('resolves Microsoft attribution in the connected Azure organization while sharing the social account read', async () => {
    const source = azureSource()
    const socialAccount = vi.fn(async () => ({
      identities: [microsoft],
      githubRepoIdentity: { githubUserId: '123', login: 'alex' },
      hasSecurityVerificationMethod: true
    }))
    expect(await resolveCommitAuthors(VIEWER, { socialAccount, azureDevOps: source })).toEqual([
      GITHUB,
      { provider: 'azure-devops', host: 'dev.azure.com', name: 'Alex Example', email: microsoft.email }
    ])
    expect(socialAccount).toHaveBeenCalledOnce()
    expect(source.connections.listForOrg).toHaveBeenCalledWith(VIEWER.orgId)
    expect(source.userFor).toHaveBeenCalledWith(azureConnection, microsoft.userId, microsoft.email)
  })

  it.each([
    { identities: [] },
    { identities: [{ ...microsoft, email: undefined }] },
    { identities: [{ ...microsoft, userId: 'display-name' }] }
  ])('does not use an installer or infer a Microsoft link from profile text (%j)', async ({ identities }) => {
    const source = azureSource()
    expect(
      await resolveCommitAuthors(VIEWER, {
        socialAccount: async () => ({
          identities,
          primaryEmail: microsoft.email,
          hasSecurityVerificationMethod: true
        }),
        azureDevOps: source
      })
    ).toEqual([])
    expect(source.connections.listForOrg).not.toHaveBeenCalled()
    expect(source.userFor).not.toHaveBeenCalled()
  })

  it('omits missing, ambiguous, or unavailable Azure matches while keeping other providers', async () => {
    const source = azureSource()
    const deps: CommitAuthorsDeps = {
      socialAccount: async () => ({
        identities: [microsoft],
        githubRepoIdentity: { githubUserId: '123', login: 'alex' },
        hasSecurityVerificationMethod: true
      }),
      azureDevOps: source
    }
    source.connections.listForOrg.mockResolvedValue([azureConnection, { ...azureConnection, id: 'another-connection' }])
    expect(await resolveCommitAuthors(VIEWER, deps)).toEqual([GITHUB])
    expect(source.userFor).not.toHaveBeenCalled()
    source.connections.listForOrg.mockResolvedValue([azureConnection])
    source.userFor.mockResolvedValue(null)
    expect(await resolveCommitAuthors(VIEWER, deps)).toEqual([GITHUB])
    source.userFor.mockRejectedValue(new Error('Azure DevOps unavailable'))
    expect(await resolveCommitAuthors(VIEWER, deps)).toEqual([GITHUB])
  })

  it.each([
    {
      identities: [
        { target: 'github', userId: '123', profileUrl: 'https://github.com/alex', email: 'private@example.test' }
      ]
    },
    { identities: [], githubRepoIdentity: { githubUserId: '123', login: 'alex' } }
  ])('uses a linked GitHub identity with its noreply address', async (linked) => {
    const account: SocialAccount = { ...linked, hasSecurityVerificationMethod: true }
    expect(await resolveCommitAuthors(VIEWER, { socialAccount: async () => account })).toEqual([GITHUB])
  })

  it('does not guess an identity from an email or fall back past an incomplete social link', async () => {
    expect(
      await resolveCommitAuthors(VIEWER, {
        socialAccount: async () => ({
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
    source.currentUser.mockResolvedValue({
      id: 42,
      username: 'alex-lab',
      commit_email: 'private@example.test',
      public_email: ''
    })
    expect(await resolveCommitAuthors(VIEWER, { gitlab: source })).toEqual([])
  })

  it('keeps available identities when another provider fails and rejects multiline trailer data', async () => {
    const deps: CommitAuthorsDeps = {
      socialAccount: async () => ({
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
