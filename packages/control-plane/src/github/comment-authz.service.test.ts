import { describe, expect, it, vi } from 'vitest'
import type { RcGithubCommentAuthz } from '@agentconnect.md/protocol'
import { AgentId, HookId, OrgId } from '../domain/ids.js'
import type { GithubInstallationRecord, GithubInstallationRepo, HookRecord, HookRepo } from '../persistence/ports.js'
import type { GithubService } from './service.js'
import { GithubCommentAuthzService } from './comment-authz.service.js'

const HOOK_ID = '88888888-8888-4888-8888-888888888888'
const SIBLING_HOOK_ID = '99999999-9999-4999-8999-999999999999'
const REPO_ID = 987654321n
const INSTALLATION_ID = 123456n
const ORG_ID = OrgId('org-a')
const AGENT_ID = AgentId('33333333-3333-4333-8333-333333333333')
const SIBLING_AGENT_ID = AgentId('44444444-4444-4444-8444-444444444444')
const CONFIG_REVISION = 7n
const DISPATCH_REVISION = 9n
const SIBLING_CONFIG_REVISION = 11n
const SIBLING_DISPATCH_REVISION = 13n

const request: RcGithubCommentAuthz = {
  hookId: HOOK_ID,
  installationId: INSTALLATION_ID.toString(),
  repoId: REPO_ID.toString(),
  repoFullName: 'acme/infra',
  senderLogin: 'octocat',
  configRevision: CONFIG_REVISION.toString(),
  dispatchRevision: DISPATCH_REVISION.toString()
}
const batchRequest: RcGithubCommentAuthz = {
  ...request,
  siblingFences: [
    {
      hookId: SIBLING_HOOK_ID,
      configRevision: SIBLING_CONFIG_REVISION.toString(),
      dispatchRevision: SIBLING_DISPATCH_REVISION.toString()
    }
  ]
}

function hook(over: Partial<HookRecord> = {}): HookRecord {
  return {
    id: HookId(HOOK_ID),
    orgId: ORG_ID,
    agentId: AGENT_ID,
    kind: 'github',
    enabled: true,
    repoId: REPO_ID,
    configRevision: CONFIG_REVISION,
    dispatchRevision: DISPATCH_REVISION,
    ...over
  } as HookRecord
}

function siblingHook(over: Partial<HookRecord> = {}): HookRecord {
  return hook({
    id: HookId(SIBLING_HOOK_ID),
    agentId: SIBLING_AGENT_ID,
    configRevision: SIBLING_CONFIG_REVISION,
    dispatchRevision: SIBLING_DISPATCH_REVISION,
    ...over
  })
}

function installation(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
  return {
    id: 'installation-row',
    orgId: ORG_ID,
    installationId: INSTALLATION_ID,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspendedAt: null,
    permissions: { metadata: 'read' },
    revokedAt: null,
    createdAt: new Date(0),
    ...over
  }
}

type Permission = Awaited<ReturnType<GithubService['userRepoPermissionForCommentAuthz']>>

function make(
  opts: {
    hook?: HookRecord
    hooks?: HookRecord[]
    permission?: Permission
    permissions?: Partial<Record<string, Permission>>
    /** What `GET /users/{login}` answers; a login absent here does not exist on the host. */
    users?: Partial<Record<string, bigint>>
    /** The repository's "Trusted users" — numeric ids. */
    trusted?: bigint[]
    timeoutMs?: number
  } = {}
) {
  const getMany = vi.fn(async () => opts.hooks ?? [opts.hook ?? hook()])
  const getByInstallationId = vi.fn(async () => installation())
  const repoRefForCommentAuthz = vi.fn(async () => ({
    repoId: REPO_ID,
    fullName: request.repoFullName,
    private: true
  }))
  const userRepoPermissionForCommentAuthz = vi.fn(
    async (_installation: GithubInstallationRecord, _owner: string, _repo: string, username: string) =>
      opts.permissions?.[username] ?? opts.permission ?? 'write'
  )
  const userByLogin = vi.fn(async (_installation: GithubInstallationRecord, login: string) => {
    const id = opts.users?.[login]
    return id === undefined ? null : { id, login }
  })
  const actorIdsForRepo = vi.fn(async () => new Set((opts.trusted ?? []).map((id) => id.toString())))
  const service = new GithubCommentAuthzService({
    hooks: { getManyUnscoped: getMany } as unknown as Pick<HookRepo, 'getManyUnscoped'>,
    installations: { getByInstallationId } as unknown as Pick<GithubInstallationRepo, 'getByInstallationId'>,
    github: { repoRefForCommentAuthz, userRepoPermissionForCommentAuthz, userByLogin } as unknown as Pick<
      GithubService,
      'repoRefForCommentAuthz' | 'userRepoPermissionForCommentAuthz' | 'userByLogin'
    >,
    trustedActors: { actorIdsForRepo },
    timeoutMs: opts.timeoutMs
  })
  return {
    service,
    getMany,
    getByInstallationId,
    repoRefForCommentAuthz,
    userRepoPermissionForCommentAuthz,
    userByLogin,
    actorIdsForRepo
  }
}

describe('GithubCommentAuthzService', () => {
  it('allows a current hook when GitHub reports write permission', async () => {
    const h = make({ permission: 'write' })
    await expect(h.service.allowed(request)).resolves.toBe(true)
    expect(h.getMany).toHaveBeenCalledTimes(2)
    expect(h.userRepoPermissionForCommentAuthz).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: INSTALLATION_ID }),
      'acme',
      'infra',
      'octocat'
    )
  })

  it('denies read-only repository permission', async () => {
    await expect(make({ permission: 'read' }).service.allowed(request)).resolves.toBe(false)
  })

  it('allows the triage role, which GitHub lets request a pull request review', async () => {
    await expect(make({ permission: 'triage' }).service.allowed(request)).resolves.toBe(true)
  })

  it('denies when one actor holds triage and the other is read-only', async () => {
    const h = make({ permissions: { octocat: 'triage', 'issue-author': 'read' } })

    await expect(h.service.allowed({ ...request, subjectAuthorLogin: 'issue-author' })).resolves.toBe(false)
  })

  it('requires write permission from both an unmentioned commenter and the thread author', async () => {
    const h = make({ permissions: { octocat: 'write', 'issue-author': 'read' } })

    await expect(h.service.allowed({ ...request, subjectAuthorLogin: 'issue-author' })).resolves.toBe(false)
    expect(h.userRepoPermissionForCommentAuthz).toHaveBeenCalledTimes(2)
  })

  it('denies a stale config revision before consulting GitHub', async () => {
    const h = make({ hook: hook({ configRevision: CONFIG_REVISION + 1n }) })

    await expect(h.service.allowed(request)).resolves.toBe(false)
    expect(h.getByInstallationId).not.toHaveBeenCalled()
    expect(h.repoRefForCommentAuthz).not.toHaveBeenCalled()
  })

  it('denies when the hook changes during the permission lookup', async () => {
    const h = make()
    h.getMany
      .mockResolvedValueOnce([hook()])
      .mockResolvedValueOnce([hook({ dispatchRevision: DISPATCH_REVISION + 1n })])

    await expect(h.service.allowed(request)).resolves.toBe(false)
    expect(h.getMany).toHaveBeenCalledTimes(2)
    expect(h.userRepoPermissionForCommentAuthz).toHaveBeenCalledOnce()
  })

  it('allows a current batch with one GitHub permission lookup', async () => {
    const h = make({ hooks: [hook(), siblingHook()] })

    await expect(h.service.allowed(batchRequest)).resolves.toBe(true)
    expect(h.getMany).toHaveBeenCalledTimes(2)
    expect(h.userRepoPermissionForCommentAuthz).toHaveBeenCalledOnce()
  })

  it('denies the batch when a sibling changes while the representative remains current', async () => {
    const h = make({ hooks: [hook(), siblingHook()] })
    h.getMany
      .mockResolvedValueOnce([hook(), siblingHook()])
      .mockResolvedValueOnce([hook(), siblingHook({ enabled: false })])

    await expect(h.service.allowed(batchRequest)).resolves.toBe(false)
    expect(h.userRepoPermissionForCommentAuthz).toHaveBeenCalledOnce()
  })

  // "Trusted users" (webhook-triggers-and-github-events.md): a maintainer's vouch, matched by id.
  it('admits an actor the role gate refuses when the repository trusts that numeric id', async () => {
    const h = make({ permission: 'read', users: { octocat: 583231n }, trusted: [583231n] })
    await expect(h.service.allowed(request)).resolves.toBe(true)
    expect(h.actorIdsForRepo).toHaveBeenCalledWith(ORG_ID, 'github', REPO_ID)
    expect(h.userByLogin).toHaveBeenCalledWith(expect.objectContaining({ installationId: INSTALLATION_ID }), 'octocat')
  })

  it('never resolves a login for an actor the role gate already admitted', async () => {
    const h = make({ permission: 'write', trusted: [583231n] })
    await expect(h.service.allowed(request)).resolves.toBe(true)
    expect(h.actorIdsForRepo).not.toHaveBeenCalled()
    expect(h.userByLogin).not.toHaveBeenCalled()
  })

  it('denies a refused actor whose login is unknown to the host, even with an id on the list', async () => {
    // A renamed-away login vouches for nobody: only the resolved id can match.
    const h = make({ permission: 'read', users: {}, trusted: [583231n] })
    await expect(h.service.allowed(request)).resolves.toBe(false)
  })

  it('denies a refused actor whose resolved id is not the one the maintainer vouched for', async () => {
    const h = make({ permission: 'read', users: { octocat: 9n }, trusted: [583231n] })
    await expect(h.service.allowed(request)).resolves.toBe(false)
  })

  it('requires every refused actor of an unmentioned continuation to be trusted', async () => {
    // The commenter is vouched for; the subject author is neither vouched for nor a role-holder.
    const h = make({
      permissions: { octocat: 'read', outsider: 'none' },
      users: { octocat: 583231n, outsider: 77n },
      trusted: [583231n]
    })
    await expect(h.service.allowed({ ...request, subjectAuthorLogin: 'outsider' })).resolves.toBe(false)
  })

  it('propagates operational GitHub failures', async () => {
    const h = make()
    h.userRepoPermissionForCommentAuthz.mockRejectedValueOnce(new Error('GitHub unavailable'))
    await expect(h.service.allowed(request)).rejects.toThrow('GitHub unavailable')
  })

  it('bounds the entire authorization operation', async () => {
    vi.useFakeTimers()
    try {
      const h = make({ timeoutMs: 25 })
      h.getMany.mockImplementationOnce(() => new Promise<HookRecord[]>(() => {}))

      const verdict = h.service.allowed(request)
      const rejected = expect(verdict).rejects.toThrow('GitHub comment authorization timed out')
      await vi.advanceTimersByTimeAsync(25)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
