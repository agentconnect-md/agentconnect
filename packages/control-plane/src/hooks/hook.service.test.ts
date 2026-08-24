/**
 * `HookService.compile` — HookDef → relay rule, and the null cases that pull a
 * hook OUT of the pool (webhook-triggers-and-github-events.md decision 4). Pure
 * logic over faked repos: no DB, no I/O.
 */
import { describe, it, expect, vi } from 'vitest'
import { HookService, type HookAgentReads } from './hook.service.js'
import type {
  AgentRecord,
  GithubInstallationRecord,
  GitlabAgentAccountRecord,
  GitlabProjectBindingRecord,
  GitlabWebhookSecretStore,
  HookRecord,
  HookRepo,
  HookSecretStore
} from '../persistence/ports.js'
import type { RelayControlSender } from '../orchestrator/relayControl.js'
import { AgentId, HookId, IntegrationId, OrgId } from '../domain/ids.js'

const INTEGRATION = IntegrationId('33333333-3333-4333-8333-333333333333')

const HOOK = HookId('11111111-1111-4111-8111-111111111111')
const AGENT = AgentId('22222222-2222-4222-8222-222222222222')
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

// A legacy row: `compile` branches explicitly on the revision columns being absent.
function hook(over: Partial<HookRecord> = {}): HookRecord {
  return {
    id: HOOK,
    orgId: 'org' as HookRecord['orgId'],
    agentId: AGENT,
    kind: 'webhook',
    name: 'ci',
    enabled: true,
    sessionMode: 'perDelivery',
    urlToken: 'whk_tok1',
    hmacConfigured: false,
    repoId: null,
    repoFullName: null,
    events: [],
    commentFamilies: [],
    labelFilter: [],
    mentionOnly: false,
    targetPlatform: 'slack',
    targetChannel: null,
    targetIntegrationId: null,
    lastFiredAt: null,
    createdBy: null,
    createdByUserId: null,
    createdAt: new Date(),
    lastModifiedAt: new Date(),
    lastModifiedBy: null,
    ...over
  } as HookRecord
}

/** Minimal installation rows for the github-compile fakes. */
function installation(id: bigint, over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
  return {
    id: `row-${id}`,
    orgId: OrgId('org'),
    installationId: id,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    permissions: {},
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...over
  }
}

/** One agent's ready service account on the binding (§7.2). */
function account(agentId: string, userId: bigint): GitlabAgentAccountRecord {
  return {
    id: `account-${userId}`,
    orgId: 'org',
    agentId,
    rootGroupId: 77n,
    serviceAccountUserId: userId,
    username: `review-agent-${agentId.replace(/-/g, '').slice(0, 12)}-25`,
    displayName: 'review-agent',
    avatarFingerprint: null,
    createAttempt: null,
    credentialEpoch: 1n,
    administeringConnectionId: null,
    generation: 1n,
    lifecycle: 'active',
    state: 'ready',
    stateReason: null
  }
}

/** A ready gitlab binding — the gitlab-compile source (§11.3). */
function binding(over: Partial<GitlabProjectBindingRecord> = {}): GitlabProjectBindingRecord {
  return {
    id: 'binding-1',
    orgId: 'org',
    projectId: 4455667n,
    projectPath: 'example-group/example-project',
    defaultBranch: 'main',
    installerConnectionId: null,
    webhookId: 12n,
    desiredEventsHash: null,
    credentialEpoch: 1n,
    convergeOwedAt: null,
    state: 'ready',
    stateReason: null,
    createdAt: new Date(),
    ...over
  }
}

/** A HookService with faked deps + a spy RelayControlSender capturing pushes. */
function make(
  opts: {
    daemonId?: string | null
    secret?: string | null
    installations?: GithubInstallationRecord[]
    appSlug?: string
    hooks?: Partial<HookRepo>
    pause?: boolean | null
    gitlabBinding?: Partial<GitlabProjectBindingRecord> | null
    gitlabAccounts?: GitlabAgentAccountRecord[]
  } = {}
) {
  const agents: HookAgentReads = {
    getUnscoped: vi.fn(async () =>
      opts.daemonId === null
        ? null
        : ({
            id: AGENT,
            name: 'review-agent',
            daemonId: opts.daemonId ?? DAEMON,
            ...(opts.pause !== undefined ? { pause: opts.pause } : {})
          } as AgentRecord)
    )
  }
  const secrets = { get: vi.fn(async () => opts.secret ?? null) } as unknown as HookSecretStore
  const hooks = (opts.hooks ?? {}) as HookRepo
  const assigns: unknown[] = []
  const removes: string[] = []
  const relayControl = {
    hookAssign: (rule: unknown) => assigns.push(rule),
    hookRemove: (id: string) => removes.push(id)
  } as unknown as RelayControlSender
  const installations = opts.installations ? { listForOrg: vi.fn(async () => opts.installations!) } : undefined
  const gitlabBindings =
    opts.gitlabBinding === undefined
      ? undefined
      : { byProject: vi.fn(async () => (opts.gitlabBinding ? binding(opts.gitlabBinding) : null)) }
  const gitlabWebhookSecrets = { get: vi.fn(async () => 'whsec_example') } as unknown as GitlabWebhookSecretStore
  const gitlabAccounts =
    opts.gitlabBinding === undefined
      ? undefined
      : { listForBinding: vi.fn(async () => opts.gitlabAccounts ?? [account(AGENT, 9042n)]) }
  return {
    svc: new HookService(
      hooks,
      secrets,
      agents,
      relayControl,
      undefined,
      installations,
      opts.appSlug,
      undefined,
      gitlabBindings,
      gitlabWebhookSecrets,
      gitlabAccounts
    ),
    assigns,
    removes
  }
}

describe('HookService.compile', () => {
  it('compiles an enabled, placed webhook hook into a rule (with hmacSecret when set)', async () => {
    const { svc } = make({ secret: 'whsec_x' })
    const rule = await svc.compile(hook())
    expect(rule).toEqual({
      hookId: HOOK,
      kind: 'webhook',
      agentId: AGENT,
      daemonId: DAEMON,
      sessionMode: 'perDelivery',
      reviewPolicy: 'off',
      reportingMode: 'off',
      gateMode: 'informational',
      webhook: { urlToken: 'whk_tok1', hmacSecret: 'whsec_x' }
    })
  })

  it('omits hmacSecret when the hook has no signing secret', async () => {
    const { svc } = make({ secret: null })
    const rule = await svc.compile(hook())
    expect(rule?.webhook).toEqual({ urlToken: 'whk_tok1' })
  })

  it('carries an anchoring target only when a channel is set', async () => {
    const { svc } = make()
    const withTarget = await svc.compile(
      hook({ targetChannel: 'C123', targetPlatform: 'slack', targetIntegrationId: INTEGRATION })
    )
    expect(withTarget?.target).toEqual({ platform: 'slack', channel: 'C123', integrationId: INTEGRATION })
    const headless = await svc.compile(hook({ targetChannel: null }))
    expect(headless?.target).toBeUndefined()
  })

  it('returns null for disabled / orphaned / unplaced hooks', async () => {
    expect(await make().svc.compile(hook({ enabled: false }))).toBeNull()
    expect(await make().svc.compile(hook({ agentId: null }))).toBeNull()
    expect(await make({ daemonId: null }).svc.compile(hook())).toBeNull() // agent not placed
  })

  it('returns null for a tokenless webhook hook', async () => {
    expect(await make().svc.compile(hook({ urlToken: null }))).toBeNull()
  })

  it('keeps a paused agent out of the pool, and converges the rule to a removal', async () => {
    const { svc, assigns, removes } = make({ pause: true })

    expect(await svc.compile(hook())).toBeNull()
    await svc.broadcast(hook())
    expect(assigns).toEqual([])
    expect(removes).toEqual([HOOK])
  })

  it('compiles again once the agent resumes', async () => {
    const { svc, assigns, removes } = make({ pause: false })

    await svc.broadcast(hook())
    expect(removes).toEqual([])
    expect(assigns).toHaveLength(1)
  })

  const ghHook = (over: Partial<HookRecord> = {}) =>
    hook({
      kind: 'github',
      sessionMode: 'perThread',
      urlToken: null,
      repoId: 987654321n,
      repoFullName: 'acme/infra',
      githubSessionKey: 'github:987654321',
      events: ['issues:opened', 'issue_comment:created'],
      labelFilter: ['bug'],
      ...over
    })

  it('compiles a github hook: BigInt ids stringified, valid installation set attached', async () => {
    const { svc } = make({ installations: [installation(1234567n), installation(2345678n)] })
    const rule = await svc.compile(ghHook())
    expect(rule).toEqual({
      hookId: HOOK,
      kind: 'github',
      agentId: AGENT,
      daemonId: DAEMON,
      sessionMode: 'perThread',
      reviewPolicy: 'off',
      reportingMode: 'off',
      gateMode: 'informational',
      github: {
        repoId: '987654321',
        repoFullName: 'acme/infra',
        sessionKeyPrefix: 'github:987654321',
        events: ['issues:opened', 'issue_comment:created'],
        labelFilter: ['bug'],
        mentionOnly: false,
        agentName: 'review-agent',
        installationIds: ['1234567', '2345678']
      }
    })
  })

  it('stamps the App broadcast handle and agent target handle into every github rule', async () => {
    const { svc } = make({ installations: [installation(1234567n)], appSlug: 'example-review-app' })
    const rule = await svc.compile(ghHook())
    expect(rule?.github?.appSlug).toBe('example-review-app')
    expect(rule?.github?.agentName).toBe('review-agent')
    expect(rule?.github?.mentionOnly).toBe(false)
  })

  it('carries a non-empty comment family scope and omits the legacy empty scope', async () => {
    const { svc } = make({ installations: [installation(1234567n)] })
    const scoped = await svc.compile(ghHook({ commentFamilies: ['issues'] }))
    expect(scoped?.github?.commentFamilies).toEqual(['issues'])

    const legacy = await svc.compile(ghHook({ commentFamilies: [] }))
    expect(legacy?.github).not.toHaveProperty('commentFamilies')
  })

  it('excludes suspended installations from the attribution set', async () => {
    const { svc } = make({
      installations: [installation(1n, { suspendedAt: new Date() }), installation(2n)]
    })
    const rule = await svc.compile(ghHook())
    expect(rule?.github?.installationIds).toEqual(['2'])
  })

  it('returns null when no valid installation remains (rule must leave the pool)', async () => {
    const all = make({ installations: [installation(1n, { suspendedAt: new Date() })] })
    expect(await all.svc.compile(ghHook())).toBeNull()
    const none = make({ installations: [] })
    expect(await none.svc.compile(ghHook())).toBeNull()
  })

  it('returns null for a github hook without repo columns or without the installations dep', async () => {
    const { svc } = make({ installations: [installation(1n)] })
    expect(await svc.compile(ghHook({ repoId: null }))).toBeNull()
    expect(await svc.compile(ghHook({ repoFullName: null }))).toBeNull()
    // Deployment without the GitHub App: HookService built without the repo.
    expect(await make().svc.compile(ghHook())).toBeNull()
  })
})

describe('HookService.replayTo', () => {
  it('one hook whose compile throws must not starve the rest of the replay', async () => {
    // The github branch awaits installations.listForOrg — the first compile
    // dependency that can realistically reject (DB blip). The per-hook
    // try/catch is what keeps a (re)registering relay from losing ALL rules.
    const webhook = hook()
    const github = hook({
      id: HookId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      kind: 'github',
      sessionMode: 'perThread',
      urlToken: null,
      repoId: 1n,
      repoFullName: 'acme/infra',
      events: ['issues:*']
    })
    const agents: HookAgentReads = { getUnscoped: vi.fn(async () => ({ id: AGENT, daemonId: DAEMON }) as AgentRecord) }
    const secrets = { get: vi.fn(async () => null) } as unknown as HookSecretStore
    const hooks = { listEnabled: vi.fn(async () => [github, webhook]) } as unknown as HookRepo
    const installations = {
      listForOrg: vi.fn(async () => {
        throw new Error('db blip')
      })
    }
    const svc = new HookService(hooks, secrets, agents, {} as RelayControlSender, undefined, installations, undefined, {
      warn: vi.fn()
    })
    const sent: string[] = []
    await svc.replayTo({ send: (_type: string, rule: { hookId: string }) => sent.push(rule.hookId) } as never)
    expect(sent).toEqual([HOOK]) // the webhook rule still reached the relay
  })
})

describe('HookService.rebroadcastGithubForOrg', () => {
  it('re-converges each of the org github hooks to assign-or-remove', async () => {
    const rows = [ghFixture(HookId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')), ghFixture(HOOK, { enabled: false })]
    const { svc, assigns, removes } = make({
      installations: [installation(7n)],
      hooks: { listForOrgKind: vi.fn(async () => rows) }
    })
    await svc.rebroadcastGithubForOrg(OrgId('org'))
    expect(assigns).toHaveLength(1)
    expect(removes).toEqual([HOOK]) // the disabled one converges to remove
  })

  function ghFixture(id: ReturnType<typeof HookId>, over: Partial<HookRecord> = {}): HookRecord {
    return hook({
      id,
      kind: 'github',
      sessionMode: 'perThread',
      urlToken: null,
      repoId: 1n,
      repoFullName: 'acme/infra',
      events: ['issues:*'],
      ...over
    })
  }
})

describe('HookService.broadcast', () => {
  it('assigns a compilable hook and removes an uncompilable one', async () => {
    const on = make()
    await on.svc.broadcast(hook())
    expect(on.assigns).toHaveLength(1)
    expect(on.removes).toHaveLength(0)

    const off = make()
    await off.svc.broadcast(hook({ enabled: false }))
    expect(off.assigns).toHaveLength(0)
    expect(off.removes).toEqual([HOOK])
  })
})

const GITLAB_HOOK: Partial<HookRecord> = {
  kind: 'gitlab',
  sessionMode: 'perThread',
  urlToken: null,
  repoId: 4455667n,
  events: ['issues:*']
}

describe('HookService.compile — gitlab', () => {
  it('names the HOOK AGENT’s own account and vetoes every account bound to the project', async () => {
    const sibling = account('11111111-2222-3333-4444-555555555555', 9043n)
    const { svc } = make({ gitlabBinding: {}, gitlabAccounts: [account(AGENT, 9042n), sibling] })
    const rule = await svc.compile(hook({ ...GITLAB_HOOK }))
    expect(rule?.gitlab?.serviceAccountUserId).toBe('9042')
    expect(rule?.gitlab?.serviceAccountUsername).toBe(account(AGENT, 9042n).username)
    expect(rule?.gitlab?.boundServiceAccountUserIds).toEqual(['9042', '9043'])
  })

  it('leaves the pool while the hook agent has no ready account of its own', async () => {
    const unready = { ...account(AGENT, 9042n), state: 'provisioning' as const }
    const { svc } = make({ gitlabBinding: {}, gitlabAccounts: [unready] })
    expect(await svc.compile(hook({ ...GITLAB_HOOK }))).toBeNull()
    // A sibling agent's ready account is not this hook's identity either.
    const foreign = make({
      gitlabBinding: {},
      gitlabAccounts: [account('11111111-2222-3333-4444-555555555555', 9043n)]
    })
    expect(await foreign.svc.compile(hook({ ...GITLAB_HOOK }))).toBeNull()
  })
})
