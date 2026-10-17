import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { OrgId } from '../domain/ids.js'
import { GitlabApiClient } from '../gitlab/api.js'
import type { ExternalScopeRecord, GitlabConnectionRecord, GitlabProjectBindingRecord } from '../persistence/ports.js'
import { GitlabSessionAccessService } from './gitlab-session-access.js'
import type { SessionAccessViewer } from './session-access-plugin.js'

const baseUrl = 'https://gitlab.example.test/prefix'
const scope: ExternalScopeRecord = {
  id: 'scope',
  orgId: OrgId('org'),
  provider: 'gitlab',
  realmKey: baseUrl,
  resourceKind: 'repository',
  resourceKey: '123',
  credentialKind: 'gitlab_project_binding',
  credentialId: 'binding',
  aclRevision: 1n,
  revokedAt: null
}
const viewer: SessionAccessViewer = {
  request: {} as never,
  orgId: scope.orgId,
  userId: 'viewer',
  identitySet: new Set()
}

function setup() {
  const clock = new FakeClock(1_800_000_000_000)
  const project = {
    id: 123,
    path_with_namespace: 'example-group/project',
    visibility: 'private',
    repository_access_level: 'enabled'
  }
  const member = { access_level: 20, state: 'active', expires_at: null as string | null }
  const binding: GitlabProjectBindingRecord = {
    id: 'binding',
    orgId: scope.orgId,
    projectId: 123n,
    installerConnectionId: 'connection',
    state: 'ready',
    credentialEpoch: 1n,
    projectPath: 'example-group/project',
    defaultBranch: 'main',
    webhookId: 1n,
    desiredEventsHash: null,
    convergeOwedAt: null,
    stateReason: null,
    createdAt: new Date(clock.now())
  }
  const connection: GitlabConnectionRecord = {
    id: 'connection',
    orgId: scope.orgId,
    state: 'connected',
    tokenVersion: 1n,
    userId: null,
    gitlabUserId: 99n,
    gitlabUsername: 'administrator',
    scopes: ['api'],
    accessExpiresAt: null,
    lastSyncAt: null,
    createdAt: new Date(clock.now())
  }
  const fetch = vi.fn(async (url: string) => {
    if (url === `${baseUrl}/api/v4/projects/123`) return Response.json(project)
    if (url === `${baseUrl}/api/v4/projects/123/members/all/42`) return Response.json(member)
    throw new Error('unexpected API request')
  })
  const identity = { gitlabUserIdFor: vi.fn(async (): Promise<string | null> => '42') }
  const users = { getOidcSubject: vi.fn(async () => 'subject') }
  const service = new GitlabSessionAccessService({
    clock,
    configured: true,
    api: new GitlabApiClient(baseUrl, fetch),
    identity,
    users,
    bindings: { get: async () => binding },
    connections: { get: async () => connection },
    oauth: { withAccessToken: async () => 'admin-token' }
  })
  return { service, clock, project, member, binding, connection, fetch, identity, users }
}

describe('GitLab session audiences', () => {
  it('uses the linked instance identity for inherited membership and rechecks removal after the lease', async () => {
    const h = setup()
    expect((await h.service.resolve([scope], viewer)).allowedScopes).toHaveLength(1)
    expect(h.identity.gitlabUserIdFor).toHaveBeenCalledWith('subject', baseUrl)
    h.member.access_level = 0
    h.clock.advance(120_001)
    expect((await h.service.resolve([scope], viewer)).allowedScopes).toEqual([])
  })

  it.each([
    { access_level: 10, state: 'active', expires_at: null },
    { access_level: 40, state: 'blocked', expires_at: null },
    { access_level: 40, state: 'active', expires_at: '2020-01-01' }
  ])('denies guests, blocked members and expired memberships: %j', async (member) => {
    const h = setup()
    Object.assign(h.member, member)
    expect((await h.service.resolve([scope], viewer)).allowedScopes).toEqual([])
  })

  it('allows an anonymously readable public repository but never a disabled repository', async () => {
    const h = setup()
    h.project.visibility = 'public'
    expect((await h.service.resolve([scope], viewer)).allowedScopes).toHaveLength(1)
    expect(h.identity.gitlabUserIdFor).not.toHaveBeenCalled()
    h.project.repository_access_level = 'disabled'
    h.clock.advance(120_001)
    expect((await h.service.resolve([scope], viewer)).allowedScopes).toEqual([])
  })

  it('fences host, organization, project, revoked scopes and disconnected credentials before cached allows', async () => {
    const h = setup()
    await h.service.resolve([scope], viewer)
    for (const patch of [
      { realmKey: 'https://other.example.test' },
      { orgId: OrgId('other') },
      { resourceKey: '456' },
      { revokedAt: new Date() }
    ]) {
      expect((await h.service.resolve([{ ...scope, ...patch }], viewer)).allowedScopes).toEqual([])
    }
    h.connection.state = 'disconnected'
    expect(await h.service.resolve([scope], viewer)).toMatchObject({ allowedScopes: [], degraded: true })
  })

  it('distinguishes missing login, app authorization and provider failure without granting access', async () => {
    const h = setup()
    h.identity.gitlabUserIdFor.mockResolvedValue(null)
    expect(await h.service.resolve([scope], viewer)).toMatchObject({
      allowedScopes: [],
      accessIssues: [{ provider: 'gitlab', reason: 'authorization' }]
    })
    for (const [status, reason] of [
      [401, 'app_authorization'],
      [503, 'unavailable']
    ] as const) {
      h.clock.advance(5_001)
      h.fetch.mockResolvedValueOnce(new Response(null, { status }))
      expect(await h.service.resolve([scope], viewer)).toMatchObject({
        allowedScopes: [],
        degraded: true,
        accessIssues: [{ provider: 'gitlab', reason }]
      })
    }
  })
})
