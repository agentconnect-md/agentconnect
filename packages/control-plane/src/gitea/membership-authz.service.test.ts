/** The team half of the §8 gate (gitea-integration.md) over in-memory stores and the stateful fake edge. */
import { describe, expect, it, vi } from 'vitest'
import type { RcCodeHostMembershipAuthz } from '@agentconnect.md/protocol'
import { AgentId, HookId, OrgId } from '../domain/ids.js'
import type { GiteaConnectionRecord, GiteaRepositoryBindingRecord, HookRecord } from '../persistence/ports.js'
import { FakeGitea, type FakeGiteaTeam } from '../../test/fakes/gitea-api.js'
import { giteaTeamUnitAdmits } from './api.js'
import { GiteaMembershipAuthzService, TEAM_LOOKUP_UNAVAILABLE_REASON } from './membership-authz.service.js'

const HOOK_ID = '88888888-8888-4888-8888-888888888888'
const ORG_ID = OrgId('org-a')
const REPO_ID = 556677n

const request: RcCodeHostMembershipAuthz = {
  hookId: HOOK_ID,
  provider: 'gitea',
  repoExternalId: REPO_ID.toString(),
  actorExternalId: '515151',
  actorUsername: 'alice',
  configRevision: '7',
  dispatchRevision: '9'
}

const hook: HookRecord = {
  id: HookId(HOOK_ID),
  orgId: ORG_ID,
  agentId: AgentId('33333333-3333-4333-8333-333333333333'),
  kind: 'gitea',
  enabled: true,
  repoId: REPO_ID,
  configRevision: 7n,
  dispatchRevision: 9n
} as HookRecord

const binding: GiteaRepositoryBindingRecord = {
  id: 'binding-1',
  orgId: ORG_ID,
  connectionId: 'connection-1',
  repoId: REPO_ID,
  repoPath: 'example-org/example-repo',
  cloneUrl: null,
  defaultBranch: null,
  webhookId: 7001n,
  nextWebhookId: null,
  desiredEventsHash: null,
  lastVerifiedDeliveryAt: null,
  convergeOwedAt: null,
  state: 'ready',
  stateReason: null,
  createdAt: new Date(0)
}

const connection: GiteaConnectionRecord = {
  id: 'connection-1',
  orgId: ORG_ID,
  createdByUserId: null,
  botUserId: 9042n,
  botUsername: 'example-bot',
  botDisplayName: null,
  credentialEpoch: 1n,
  instanceVersion: '1.27.3',
  state: 'connected',
  lastVerifiedAt: null,
  createdAt: new Date(0)
}

/** A General Access team as Gitea ≥ 1.24 stores it: flat `read`, the grants only in the units. */
const codeWriters = (over: Partial<FakeGiteaTeam> = {}): FakeGiteaTeam => ({
  id: 31,
  name: 'developers',
  permission: 'read',
  units: { 'repo.code': 'write', 'repo.issues': 'write', 'repo.pulls': 'write' },
  members: ['alice'],
  ...over
})

function build(fake: FakeGitea, over: { timeoutMs?: number } = {}) {
  const warnings: Array<Record<string, unknown>> = []
  const onAuthRejected = vi.fn(async () => {})
  const service = new GiteaMembershipAuthzService({
    hooks: { getManyUnscoped: async () => [hook] },
    bindings: { byRepo: async () => binding },
    connections: { get: async () => connection },
    tokens: { withToken: async () => fake.token, onAuthRejected },
    trustedActors: { actorIdsForRepo: async () => new Set<string>() },
    api: fake.api,
    log: { warn: (obj) => warnings.push(obj as Record<string, unknown>) },
    ...over
  })
  return { service, warnings, onAuthRejected }
}

describe('giteaTeamUnitAdmits', () => {
  it('admits repo.code at write or above, or a flat admin/owner mode, and nothing else', () => {
    expect(giteaTeamUnitAdmits({ 'repo.code': 'write' }, 'read')).toBe(true)
    expect(giteaTeamUnitAdmits({ 'repo.code': 'admin' }, 'read')).toBe(true)
    expect(giteaTeamUnitAdmits({ 'repo.code': 'owner' }, 'read')).toBe(true)
    expect(giteaTeamUnitAdmits({}, 'admin')).toBe(true)
    expect(giteaTeamUnitAdmits(undefined, 'owner')).toBe(true)
    // Pull, issue, or wiki write alone is not push permission.
    expect(giteaTeamUnitAdmits({ 'repo.code': 'read', 'repo.pulls': 'write', 'repo.issues': 'write' }, 'read')).toBe(
      false
    )
    expect(giteaTeamUnitAdmits({ 'repo.pulls': 'write' }, 'write')).toBe(false)
    expect(giteaTeamUnitAdmits({ 'repo.code': 'none' }, 'read')).toBe(false)
    expect(giteaTeamUnitAdmits(undefined, 'read')).toBe(false)
    expect(giteaTeamUnitAdmits(undefined, undefined)).toBe(false)
  })
})

describe('GiteaMembershipAuthzService — the team fallback (§8)', () => {
  it('admits through a qualifying team the bot can read, in the documented request order', async () => {
    const fake = new FakeGitea({ permissions: { alice: 'read' }, teams: [codeWriters()] })
    const { service, warnings } = build(fake)
    expect(await service.allowed(request)).toBe(true)
    expect(fake.requests.map((r) => r.url.replace(`${fake.opts.baseUrl}/api/v1`, ''))).toEqual([
      '/users/alice',
      '/repos/example-org/example-repo/collaborators/alice/permission',
      '/repos/example-org/example-repo/teams',
      '/teams/31',
      '/teams/31/members/alice'
    ])
    expect(warnings).toEqual([])
  })

  it('names team_lookup_unavailable only when every qualifying team is unreadable', async () => {
    const fake = new FakeGitea({ permissions: { alice: 'read' }, teams: [codeWriters()], botRole: 'org_member' })
    const { service, warnings } = build(fake)
    expect(await service.allowed(request)).toBe(false)
    expect(warnings).toEqual([expect.objectContaining({ reason: TEAM_LOOKUP_UNAVAILABLE_REASON, teams: 1 })])
    // A second, readable team refusing makes the denial the user's: nothing more is logged.
    fake.teams.push(codeWriters({ id: 32, visibility: 'public', members: ['mallory'] }))
    expect(await service.allowed(request)).toBe(false)
    expect(warnings).toHaveLength(1)
  })

  it('lets a token rejection on a team route flip the connection like any other', async () => {
    const fake = new FakeGitea({ permissions: { alice: 'read' }, teams: [codeWriters()] })
    fake.opts.intercept = (method, route) =>
      method === 'GET' && route === '/teams/31'
        ? Response.json({ message: 'token is required' }, { status: 401 })
        : undefined
    const { service, onAuthRejected } = build(fake)
    expect(await service.allowed(request)).toBe(false)
    expect(onAuthRejected).toHaveBeenCalledWith(ORG_ID, 'connection-1')
  })

  it('propagates the bounded timeout when the team routes stall', async () => {
    const fake = new FakeGitea({ permissions: { alice: 'read' }, teams: [codeWriters()] })
    let release: () => void = () => {}
    fake.opts.gate = async (_method, route) => {
      if (route === '/teams/31') await new Promise<void>((resolve) => (release = resolve))
    }
    const { service } = build(fake, { timeoutMs: 30 })
    await expect(service.allowed(request)).rejects.toThrow('timed out')
    release()
  })
})
