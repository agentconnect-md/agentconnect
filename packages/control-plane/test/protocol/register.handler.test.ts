/**
 * Phase 2 — `register` handler red→green (design §6 Phase 2).
 *
 * After `auth/ok`, a `register` frame returns `register/ok` carrying the
 * authoritative reconcile snapshot (`assignments` / `crons` / `leases` / `drop`)
 * built from seeded C6 state; re-sending `register` is idempotent (same
 * snapshot, CP wins all conflicts); and a non-`auth`/`register` frame before
 * READY is rejected with `error{code:"PROTOCOL_STATE"}` (protocol §2.1).
 *
 * Runs over the `InMemoryDaemonStub` against real Testcontainers Postgres.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  GITLAB_COM_V1_FEATURE,
  GITLAB_DEFAULT_BASE_URL,
  GITLAB_INSTANCE_V1_FEATURE,
  isFrame
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import type { GithubService } from '../../src/github/service.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const WORKSPACE = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5'
const CRON = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const LEASE = '11ea5e00-0000-4000-8000-000000000001'

const AUTH_ID = '11111111-1111-4111-8111-111111111111'
const REG_ID = '22222222-2222-4222-8222-222222222222'
const REG_ID2 = '33333333-3333-4333-8333-333333333333'
const MOVE_ID = '44444444-4444-4444-8444-444444444444'

/**
 * Seed a daemon + agent + workspace, one ACTIVE assignment for the daemon, one
 * cron for the org, and one active lease for the daemon. The workspace id is an
 * explicit UUID (the wire `RouteAssign.workspaceId` / `SecretsGrant.scope` are
 * `uuid`, and `register/ok` re-validates against the protocol schema at the stub).
 */
async function seedReconcileState(): Promise<void> {
  await prisma.daemon.create({
    data: { id: DAEMON, orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, routingEpoch: 7n, maxAgents: 4, status: 'ready' }
  })
  await prisma.agent.create({
    data: {
      id: AGENT,
      orgId: DEFAULT_ORG_ID,
      name: 'agent-1',
      runtime: 'claude',
      daemonId: DAEMON
    }
  })

  await prisma.assignment.create({
    data: {
      platform: 'slack',
      channel: 'C123',
      thread: 'T9',
      agentId: AGENT,
      daemonId: DAEMON,
      workspaceId: WORKSPACE,
      assignedEpoch: 1n,
      routingEpoch: 7n,
      state: 'active',
      bindRules: [{ match: { kind: 'mention' } }]
    }
  })

  await prisma.cronDef.create({
    data: {
      id: CRON,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      schedule: '0 9 * * *',
      timezone: 'Asia/Singapore',
      targetPlatform: 'slack',
      targetChannel: 'C123',
      trigger: 'daily standup',
      enabled: true
    }
  })

  await prisma.secretLease.create({
    data: {
      id: LEASE,
      daemonId: DAEMON,
      scopePlatform: 'slack',
      scopeWorkspaceId: WORKSPACE,
      ref: 'vault://kv/slack/ws-1',
      ttlSec: 3600,
      renewBeforeSec: 60,
      status: 'active',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000)
    }
  })
}

function authPayload(token: string) {
  return { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }
}

/** A register payload whose localState claims one stale assignment + cron the CP no longer owns. */
function registerPayload() {
  return {
    host: 'host-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
    maxAgents: 4,
    localState: {
      assignments: ['slack:C123:T9', 'slack:CDEAD:-'], // second is stale → drop
      crons: [CRON, 'deadcron-0000-4000-8000-000000000000'], // second is stale → drop
      leases: [LEASE],
      agents: [],
      integrations: [],
      stagedAgents: [] as Array<{ agentId: string; moveId?: string }>
    }
  }
}

async function authThenAwaitOk(h: ReturnType<typeof buildWsHarness>) {
  const token = await h.mintToken(DAEMON)
  const { conn, stub } = h.connect()
  stub.inject('auth', authPayload(token), { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  return { conn, stub }
}

describe('register handler — authoritative reconcile snapshot + idempotency + state gate', () => {
  it('replies READY before handing durable staged moves to reconnect recovery', async () => {
    await seedReconcileState()
    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)
    const recover = vi.fn(async () => {
      expect(stub.lastSent('register/ok')).toBeDefined()
      expect(h.deps.connReg.get(DAEMON)?.state).toBe('READY')
    })
    h.deps.recoverStagedAgent = recover

    const payload = registerPayload()
    payload.localState.stagedAgents = [{ agentId: AGENT, moveId: MOVE_ID }]
    stub.inject('register', payload, { id: REG_ID })
    await stub.expectFrame('register/ok')
    await vi.waitFor(() => expect(recover).toHaveBeenCalledWith(AGENT, DAEMON, MOVE_ID))
  })

  it('after auth/ok, register → register/ok with the seeded reconcile snapshot', async () => {
    await seedReconcileState()
    const h = buildWsHarness(prisma)
    h.deps.github = {
      getGitCommitIdentity: async () => ({
        name: 'agentconnect-example[bot]',
        email: '123456+agentconnect-example[bot]@users.noreply.github.com'
      })
    } as GithubService
    const { stub } = await authThenAwaitOk(h)

    stub.inject('register', registerPayload(), { id: REG_ID })
    const ok = await stub.expectFrame('register/ok')
    expect(isFrame('register/ok')(ok)).toBe(true)
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')

    expect(ok.corr).toBe(REG_ID)
    const snap = ok.payload

    expect(snap.gitCommitIdentity).toEqual({
      name: 'agentconnect-example[bot]',
      email: '123456+agentconnect-example[bot]@users.noreply.github.com'
    })

    // routingEpoch re-issued as-is (convergence, not bump).
    expect(snap.routingEpoch).toBe(7)

    // assignments: exactly the one active row for this daemon, as a RouteAssign.
    expect(snap.assignments).toHaveLength(1)
    expect(snap.assignments[0]!.sessionKey).toEqual({ platform: 'slack', channel: 'C123', thread: 'T9' })
    expect(snap.assignments[0]!.agentId).toBe(AGENT)
    expect(snap.assignments[0]!.workspaceId).toBe(WORKSPACE)
    expect(snap.assignments[0]!.bindRules).toEqual([{ match: { kind: 'mention' } }])

    // crons: the agent's cron (per-daemon scope via agent placement), as a CronUpsert.
    expect(snap.crons).toHaveLength(1)
    expect(snap.crons[0]!.cronId).toBe(CRON)
    expect(snap.crons[0]!.agentId).toBe(AGENT)
    expect(snap.crons[0]!.timezone).toBe('Asia/Singapore')
    expect(snap.crons[0]!.target).toEqual({ platform: 'slack', channel: 'C123' })
    expect(snap.crons[0]!.trigger).toBe('daily standup')

    // leases: the daemon's active lease, as a SecretsGrant (ref only — no plaintext).
    expect(snap.leases).toHaveLength(1)
    expect(snap.leases[0]!.leaseId).toBe(LEASE)
    expect(snap.leases[0]!.ref).toBe('vault://kv/slack/ws-1')
    expect(snap.leases[0]!.ttl).toBe(3600)

    // agents: ONLY the agents placed on THIS daemon (1 agent : 1 machine) — a
    // daemon never receives specs for agents owned by other machines.
    expect(snap.agents).toHaveLength(1)
    expect(snap.agents[0]!).toEqual({
      agentId: AGENT,
      orgId: DEFAULT_ORG_ID,
      name: 'agent-1',
      displayName: null,
      // Always shipped value-or-null (like displayName): null here — no icon set and no
      // PUBLIC_CP_URL configured in the test, so the reconcile snapshot carries no URL.
      iconUrl: null,
      // Always shipped as a string: "" here so clearing the system-prompt seed
      // replicates (overwrites a stale value) instead of being omitted. Uses "" not
      // null because older daemons parse description as a non-nullable string.
      description: '',
      runtime: 'claude',
      // Per-runtime override vocabularies, always shipped as null when unset: a runtime
      // switch must replicate the CLEAR (an absent key would read as "leave alone" and
      // strand the previous runtime's value in the daemon's agent.json).
      model: null,
      reasoningEffort: null,
      permissionMode: null,
      showFooter: true,
      showStatusBar: false,
      allowRuntimeChangesInChat: false,
      env: {}, // always shipped — an absent env would read as "leave alone" on the daemon
      secrets: {}, // write-only secrets ride the same wire as env; always shipped (even {})
      // The ordering fence full-map env/secret replacement depends on
      // (organization-secrets-and-variables.md §7): a decimal string, so a bigint
      // revision survives JSON. A freshly seeded agent is at revision 0.
      configRevision: '0',
      mcpServers: [], // likewise always shipped (disabling the last server must replicate)
      skills: [], // resolved skill entries; always shipped (disabling the last skill must replicate)
      managedSkills: [], // managed organization skill bindings; likewise always shipped
      // Agent→agent call policy (§2.5), always shipped so a policy/allow-list change replicates.
      callPolicy: 'all',
      allowedCallerAgentIds: [],
      outboundPolicy: 'all',
      allowedTargetAgentIds: [],
      // #536: self-introduce-on-join — always shipped (definite column) so a toggle replicates.
      introduceOnJoin: false,
      // #642: sandbox preference — always shipped (definite column); default false.
      runInSandbox: false,
      // Preset marker — always shipped so the daemon can gate preset-only capabilities.
      builtin: false,
      // The additional-repository allowlist rides the workspace; always shipped so a revoke replicates.
      workspace: { mode: 'scratch', isolation: 'shared', gitCredential: 'github-app', additionalRepos: [] }
    })

    // drop: the stale local keys the CP no longer owns for this daemon.
    expect(snap.drop.assignments).toEqual(['slack:CDEAD:-'])
    expect(snap.drop.crons).toEqual(['deadcron-0000-4000-8000-000000000000'])
    expect(snap.drop.agents).toEqual([])
    expect(snap.drop.integrations).toEqual([])
  })

  it('quarantines one historical unsafe workspace without stranding the rest of the daemon roster', async () => {
    await seedReconcileState()
    const SAFE_AGENT = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'
    await prisma.agent.update({
      where: { id: AGENT },
      data: { workspaceMode: 'github', gitRepo: 'file:///var/lib/agentconnect/other-workspace' }
    })
    await prisma.agent.create({
      data: {
        id: SAFE_AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'safe-agent',
        runtime: 'claude',
        daemonId: DAEMON
      }
    })

    const base = registerPayload()
    const payload = {
      ...base,
      localState: {
        ...base.localState,
        agents: [{ agentId: AGENT, origin: 'cp' as const }]
      }
    }
    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)

    stub.inject('register', payload, { id: REG_ID })
    const ok = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')

    expect(ok.payload.agents.map((agent) => agent.agentId)).toEqual([SAFE_AGENT])
    expect(ok.payload.assignments).toEqual([])
    expect(ok.payload.crons).toEqual([])
    expect(ok.payload.drop.assignments).toContain('slack:C123:T9')
    expect(ok.payload.drop.crons).toContain(CRON)
    expect(ok.payload.drop.agents).toEqual([{ agentId: AGENT, action: 'detach' }])
  })

  it('drops legacy moved and unplaced replicas, but preserves unknown local-only config', async () => {
    await seedReconcileState()
    const OTHER_DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const MOVED_AGENT = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'
    const UNPLACED_AGENT = '29292929-2929-4929-8929-292929292929'
    const DELETED_AGENT = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'
    const LOCAL_AGENT = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4'
    const BOT = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5'
    const MOVED_INTEGRATION = 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6'
    const DELETED_INTEGRATION = '07070707-0707-4707-8707-070707070707'
    const LOCAL_INTEGRATION = '18181818-1818-4818-8818-181818181818'

    await prisma.daemon.create({
      data: {
        id: OTHER_DAEMON,
        orgId: DEFAULT_ORG_ID,
        sessionEpoch: 1n,
        routingEpoch: 1n,
        maxAgents: 4,
        status: 'ready'
      }
    })
    await prisma.agent.create({
      data: {
        id: MOVED_AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'moved-agent',
        runtime: 'claude',
        daemonId: OTHER_DAEMON
      }
    })
    await prisma.agent.create({
      data: {
        id: UNPLACED_AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'unplaced-agent',
        runtime: 'claude',
        daemonId: null
      }
    })
    await prisma.bot.create({ data: { id: BOT, orgId: DEFAULT_ORG_ID, platform: 'slack', name: 'moved-bot' } })
    await prisma.integration.create({
      data: {
        id: MOVED_INTEGRATION,
        orgId: DEFAULT_ORG_ID,
        agentId: MOVED_AGENT,
        botId: BOT,
        platform: 'slack',
        name: 'moved-bot',
        status: 'active'
      }
    })

    const base = registerPayload()
    const payload = {
      ...base,
      localState: {
        ...base.localState,
        agents: [
          { agentId: MOVED_AGENT, origin: 'unknown' as const }, // pre-marker replica: CP row proves the move
          { agentId: UNPLACED_AGENT, origin: 'unknown' as const }, // CP row proves it belongs on no daemon
          { agentId: LOCAL_AGENT, origin: 'unknown' as const }, // no CP row: preserve hand-authored config
          { agentId: DELETED_AGENT, origin: 'cp' as const } // explicit marker proves a missed delete
        ],
        integrations: [
          { integrationId: MOVED_INTEGRATION, origin: 'unknown' as const },
          { integrationId: LOCAL_INTEGRATION, origin: 'unknown' as const },
          { integrationId: DELETED_INTEGRATION, origin: 'cp' as const }
        ]
      }
    }

    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)
    stub.inject('register', payload, { id: REG_ID })
    const ok = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')

    expect(ok.payload.drop.agents).toEqual([
      { agentId: MOVED_AGENT, action: 'detach' },
      { agentId: UNPLACED_AGENT, action: 'detach' },
      { agentId: DELETED_AGENT, action: 'remove' }
    ])
    expect(ok.payload.drop.integrations).toEqual([MOVED_INTEGRATION, DELETED_INTEGRATION])
  })

  it('reconcile roster is scoped to THIS daemon — never leaks another daemon’s agents', async () => {
    await seedReconcileState() // seeds AGENT placed on DAEMON

    // A second daemon in the SAME org, with its own agent.
    const OTHER_DAEMON = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const OTHER_AGENT = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'
    await prisma.daemon.create({
      data: {
        id: OTHER_DAEMON,
        orgId: DEFAULT_ORG_ID,
        sessionEpoch: 1n,
        routingEpoch: 1n,
        maxAgents: 4,
        status: 'ready'
      }
    })
    await prisma.agent.create({
      data: { id: OTHER_AGENT, orgId: DEFAULT_ORG_ID, name: 'other-agent', runtime: 'claude', daemonId: OTHER_DAEMON }
    })

    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)
    stub.inject('register', registerPayload(), { id: REG_ID })
    const ok = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')

    // DAEMON's roster has ONLY its own agent — the other daemon's agent is absent.
    const ids = ok.payload.agents.map((a) => a.agentId)
    expect(ids).toEqual([AGENT])
    expect(ids).not.toContain(OTHER_AGENT)
  })

  it('withholds a gitlab-workspace agent from a daemon that has not advertised gitlab-com-v1 (§17.3)', async () => {
    await seedReconcileState()
    const GITLAB_AGENT = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'
    await prisma.agent.create({
      data: {
        id: GITLAB_AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'gitlab-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        workspaceMode: 'gitlab',
        gitRepo: 'https://gitlab.com/example-group/example-project',
        gitBranch: 'main',
        workspaceRepoId: 4455667n
      }
    })

    // No features advertised: the spec would be frame-fatal — the roster omits it.
    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)
    stub.inject('register', registerPayload(), { id: REG_ID })
    const ok = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
    expect(ok.payload.agents.map((a) => a.agentId)).toEqual([AGENT])

    // Advertising the feature delivers the gitlab arm with the numeric identity.
    const h2 = buildWsHarness(prisma)
    const { stub: stub2 } = await authThenAwaitOk(h2)
    const payload = registerPayload()
    ;(payload.capabilities as { features?: string[] }).features = ['gitlab-com-v1']
    stub2.inject('register', payload, { id: 'f2f2f2f2-2222-4222-8222-222222222222' })
    const ok2 = await stub2.expectFrame('register/ok')
    if (!isFrame('register/ok')(ok2)) throw new Error('expected register/ok')
    const gitlabSpec = ok2.payload.agents.find((a) => a.agentId === GITLAB_AGENT)
    expect(ok2.payload.agents.map((a) => a.agentId).sort()).toEqual([AGENT, GITLAB_AGENT].sort())
    expect(gitlabSpec?.workspace).toMatchObject({
      mode: 'gitlab',
      gitRepo: 'https://gitlab.com/example-group/example-project',
      projectId: '4455667'
    })
  })

  describe('§24.4 self-managed host carriage and the projection gate', () => {
    const SELF_MANAGED = 'https://gitlab.example.test/gitlab'
    const CONSUMER_AGENT = 'c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4'
    const REG_ID3 = '55555555-5555-4555-8555-555555555555'

    /** Register once against an axis with exactly these advertised features. */
    async function roster(features: string[], gitlabBaseUrl?: string, id = REG_ID) {
      const h = buildWsHarness(prisma, gitlabBaseUrl !== undefined ? { gitlabBaseUrl } : {})
      const { stub } = await authThenAwaitOk(h)
      const payload = registerPayload()
      ;(payload.capabilities as { features?: string[] }).features = features
      stub.inject('register', payload, { id })
      const ok = await stub.expectFrame('register/ok')
      if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
      return ok.payload.agents
    }

    /** A gitlab-workspace agent placed on DAEMON. */
    const seedGitlabWorkspaceAgent = () =>
      prisma.agent.create({
        data: {
          id: CONSUMER_AGENT,
          orgId: DEFAULT_ORG_ID,
          name: 'gitlab-workspace-agent',
          runtime: 'claude',
          daemonId: DAEMON,
          workspaceMode: 'gitlab',
          gitRepo: `${SELF_MANAGED}/example-group/example-project`,
          gitBranch: 'main',
          workspaceRepoId: 4455667n
        }
      })

    /** A SCRATCH agent whose only GitLab consumer is an additional-repository authorization. */
    async function seedAdditionalRepoAgent(): Promise<void> {
      await prisma.agent.create({
        data: {
          id: CONSUMER_AGENT,
          orgId: DEFAULT_ORG_ID,
          name: 'scratch-with-gitlab-repo',
          runtime: 'claude',
          daemonId: DAEMON,
          workspaceMode: 'scratch'
        }
      })
      await prisma.agentRepoAuthorization.create({
        data: {
          agentId: CONSUMER_AGENT,
          provider: 'gitlab',
          repoId: 4455667n,
          repoFullName: 'example-group/example-project',
          access: 'write'
        }
      })
    }

    /** A GITHUB-workspace agent whose only GitLab consumer is an enabled gitlab hook. */
    async function seedHookOnlyAgent(): Promise<void> {
      await prisma.agent.create({
        data: {
          id: CONSUMER_AGENT,
          orgId: DEFAULT_ORG_ID,
          name: 'github-workspace-with-gitlab-hook',
          runtime: 'claude',
          daemonId: DAEMON,
          workspaceMode: 'github',
          gitRepo: 'https://github.com/example-co/infra',
          gitBranch: 'main'
        }
      })
      await prisma.hookDef.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          agentId: CONSUMER_AGENT,
          kind: 'gitlab',
          name: 'mr-review',
          sessionMode: 'perThread',
          enabled: true,
          repoId: 4455667n,
          repoFullName: 'example-group/example-project',
          events: ['merge_request:opened']
        }
      })
    }

    const consumers: Array<[string, () => Promise<unknown>]> = [
      ['a gitlab workspace', seedGitlabWorkspaceAgent],
      ['an additional-repository authorization on a scratch workspace', seedAdditionalRepoAgent],
      ['an enabled gitlab hook on a github workspace', seedHookOnlyAgent]
    ]

    for (const [label, seed] of consumers) {
      it(`withholds a spec whose GitLab consumer is ${label} from a daemon without gitlab-instance-v1`, async () => {
        await seedReconcileState()
        await seed()

        // The daemon carrying only the older bit cannot resolve a host per agent, so it
        // would fall back to GitLab.com for self-managed work. Fail closed by OMISSION.
        expect((await roster([GITLAB_COM_V1_FEATURE], SELF_MANAGED)).map((a) => a.agentId)).toEqual([AGENT])

        const advertised = await roster(
          [GITLAB_COM_V1_FEATURE, GITLAB_INSTANCE_V1_FEATURE],
          SELF_MANAGED,
          '66666666-6666-4666-8666-666666666666'
        )
        expect(advertised.map((a) => a.agentId).sort()).toEqual([AGENT, CONSUMER_AGENT].sort())
        expect(advertised.find((a) => a.agentId === CONSUMER_AGENT)?.gitlabHost).toBe(SELF_MANAGED)
        // The agent with no GitLab consumer at all carries no host on the same axis.
        expect(advertised.find((a) => a.agentId === AGENT)?.gitlabHost).toBeUndefined()
      })
    }

    it('gates nothing on the GitLab.com axis — an older daemon gets the same roster it does today', async () => {
      await seedReconcileState()
      await seedGitlabWorkspaceAgent()

      const specs = await roster([GITLAB_COM_V1_FEATURE], GITLAB_DEFAULT_BASE_URL)
      expect(specs.map((a) => a.agentId).sort()).toEqual([AGENT, CONSUMER_AGENT].sort())
      // The axis has one value, and GitLab.com is its default — not a separate mode (§24.1).
      expect(specs.find((a) => a.agentId === CONSUMER_AGENT)?.gitlabHost).toBe(GITLAB_DEFAULT_BASE_URL)

      const advertised = await roster(
        [GITLAB_COM_V1_FEATURE, GITLAB_INSTANCE_V1_FEATURE],
        GITLAB_DEFAULT_BASE_URL,
        REG_ID3
      )
      expect(advertised.map((a) => a.agentId).sort()).toEqual([AGENT, CONSUMER_AGENT].sort())
    })

    it('carries no host at all when GitLab is unconfigured, whatever the daemon advertises', async () => {
      await seedReconcileState()
      await seedGitlabWorkspaceAgent()

      const specs = await roster([GITLAB_COM_V1_FEATURE])
      expect(specs.map((a) => a.agentId).sort()).toEqual([AGENT, CONSUMER_AGENT].sort())
      expect(specs.find((a) => a.agentId === CONSUMER_AGENT)?.gitlabHost).toBeUndefined()
    })
  })

  it('reconcile roster includes a TELEGRAM integration, not just Slack', async () => {
    await seedReconcileState() // AGENT placed on DAEMON

    // A Telegram integration owned by the placed agent: durable bot + its
    // secret (plaintext at rest, read via BotSecretStore) + the install row.
    const BOT = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0'
    const INTEG = '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e'
    await prisma.bot.create({ data: { id: BOT, orgId: DEFAULT_ORG_ID, platform: 'telegram', name: 'tg-bot' } })
    await prisma.botSecret.create({ data: { botId: BOT, botToken: '123456:AAE-xyz', appToken: null } })
    await prisma.integration.create({
      data: {
        id: INTEG,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        botId: BOT,
        platform: 'telegram',
        name: 'tg-bot',
        status: 'active'
      }
    })
    await prisma.integrationChannel.create({
      data: { integrationId: INTEG, channelId: '-1001234567890', name: 'ops' }
    })

    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)
    stub.inject('register', registerPayload(), { id: REG_ID })
    const ok = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')

    // The roster must carry the telegram-shaped spec WITH its token — otherwise
    // the daemon never converges it onto agent.json and the bot never connects.
    expect(ok.payload.integrations).toHaveLength(1)
    const tg = ok.payload.integrations[0]!
    expect(tg).toMatchObject({
      integrationId: INTEG,
      agentId: AGENT,
      platform: 'telegram',
      config: { botToken: '123456:AAE-xyz' }
    })
    // A non-empty collaboration snapshot used to make this entire register/ok
    // invalid because DEFAULT_ORG_ID is intentionally not a UUID. The in-memory
    // transport schema-validates the full reply, matching the daemon decoder.
    expect(ok.payload.collabRoutes.channels).toEqual([
      {
        orgId: DEFAULT_ORG_ID,
        platform: 'telegram',
        channelId: '-1001234567890',
        agents: [
          {
            agentId: AGENT,
            daemonId: DAEMON,
            integrationId: INTEG,
            callPolicy: 'all',
            allowedCallerAgentIds: [],
            outboundPolicy: 'all',
            allowedTargetAgentIds: [],
            // Carried so a peer daemon can label this agent by name in a visible agent-call post.
            name: 'agent-1'
          }
        ]
      }
    ])
  })

  it('re-sending register is idempotent (same snapshot)', async () => {
    await seedReconcileState()
    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)

    stub.inject('register', registerPayload(), { id: REG_ID })
    const first = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(first)) throw new Error('expected register/ok')

    stub.inject('register', registerPayload(), { id: REG_ID2 })
    // Wait until a SECOND register/ok lands.
    const { vi } = await import('vitest')
    await vi.waitFor(() => {
      if (stub.sent.filter((f) => f.type === 'register/ok').length < 2) {
        throw new Error('second register/ok not yet sent')
      }
    })
    const replies = stub.sent.filter(isFrame('register/ok'))
    expect(replies).toHaveLength(2)
    // Same authoritative payload; only the corr differs.
    expect(replies[1]!.corr).toBe(REG_ID2)
    expect(replies[1]!.payload).toEqual(first.payload)
  })

  it('seeds the daemon name from the hostname on first register, then never overwrites it', async () => {
    await seedReconcileState() // daemon row has no name yet
    const h = buildWsHarness(prisma)
    const { stub } = await authThenAwaitOk(h)
    const { vi } = await import('vitest')

    // First register → name seeded from the reported host.
    stub.inject('register', registerPayload(), { id: REG_ID })
    await stub.expectFrame('register/ok')
    await vi.waitFor(async () => {
      const d = await prisma.daemon.findUnique({ where: { id: DAEMON } })
      if (d?.name !== 'host-1') throw new Error(`name not seeded yet: ${d?.name}`)
    })

    // A later register from a DIFFERENT host must not overwrite the seeded name.
    stub.inject('register', { ...registerPayload(), host: 'host-renamed' }, { id: REG_ID2 })
    await vi.waitFor(() => {
      if (stub.sent.filter((f) => f.type === 'register/ok').length < 2) throw new Error('second register/ok not yet')
    })
    const after = await prisma.daemon.findUnique({ where: { id: DAEMON } })
    expect(after?.name).toBe('host-1')
  })

  it('a non-auth/register frame before READY → error{code:PROTOCOL_STATE}', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = h.connect() // state = AUTHENTICATING, never authed

    stub.inject('heartbeat', {
      load: { cpu: 0.1, mem: 0.2, agents: 0 },
      health: 'ok',
      activeSessions: 0
    })

    const err = await stub.expectFrame('error')
    if (!isFrame('error')(err)) throw new Error('expected error frame')
    expect(err.payload.code).toBe('PROTOCOL_STATE')
    // No auth/ok or register/ok was produced.
    expect(stub.lastSent('auth/ok')).toBeUndefined()
    expect(stub.lastSent('register/ok')).toBeUndefined()
  })
})
