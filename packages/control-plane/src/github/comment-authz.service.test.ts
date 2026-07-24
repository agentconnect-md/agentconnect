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
  const userRepoPermissionForCommentAuthz = vi.fn(async () => opts.permission ?? 'write')
  const service = new GithubCommentAuthzService({
    hooks: { getMany } as unknown as Pick<HookRepo, 'getMany'>,
    installations: { getByInstallationId } as unknown as Pick<GithubInstallationRepo, 'getByInstallationId'>,
    github: { repoRefForCommentAuthz, userRepoPermissionForCommentAuthz } as unknown as Pick<
      GithubService,
      'repoRefForCommentAuthz' | 'userRepoPermissionForCommentAuthz'
    >,
    timeoutMs: opts.timeoutMs
  })
  return { service, getMany, getByInstallationId, repoRefForCommentAuthz, userRepoPermissionForCommentAuthz }
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
