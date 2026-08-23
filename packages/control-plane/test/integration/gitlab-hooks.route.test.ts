/**
 * gitlab-kind hooks (gitlab-com-integration.md M3 CP half): the create/update/
 * delete routes fenced on a managed binding (§8.3), rule compile + the §17.3
 * feature-gated broadcast (§11.3), the managed-webhook converge kick and its
 * inverse (§11.1), and rc/codehost-membership-authz resolution (§12.2).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeGitlab, type FakeGitlabOptions } from '../fakes/gitlab-api.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { GitlabAccountService } from '../../src/gitlab/account.service.js'
import { gitlabAgentAccountUsername } from '../../src/gitlab/api.js'
import { GitlabMembershipAuthzService } from '../../src/gitlab/membership-authz.service.js'
import { unionGitlabWebhookEvents } from '../../src/gitlab/webhook-events.js'
import {
  PgAgentRepo,
  PgCodeHostRepositoryRepo,
  PgGitlabAgentAccountRepo,
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabOauthStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore,
  PgHookRepo
} from '../../src/persistence/index.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'
import { AgentId, HookId, OrgId } from '../../src/domain/ids.js'
import {
  GITLAB_COM_V1_FEATURE,
  GITLAB_RERUN_V1_FEATURE,
  type RcHookAssign,
  type RcHookRerun,
  type RcHookRerunResult
} from '@agentconnect.md/protocol'
import { RelayNotWritten } from '../../src/ws/relay-registry.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PROJECT = 4455667n
const RELAY_URL = 'https://relay.example.test'
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function harness(options: FakeGitlabOptions = {}) {
  const fake = new FakeGitlab(options)
  const hookRepo = new PgHookRepo(prisma)
  const bindings = new PgGitlabProjectBindingRepo(prisma)
  const connections = new PgGitlabConnectionRepo(prisma)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1' },
    connections,
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    cipher,
    clock: systemClock,
    publicCpUrl: 'https://api.example.test',
    fetchImpl: fake.fetch()
  })
  const accounts = new PgGitlabAgentAccountRepo(prisma)
  const accountService = new GitlabAccountService({
    oauth,
    accounts,
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    agents: new PgAgentRepo(prisma),
    cipher,
    clock: systemClock,
    fetchImpl: fake.fetch()
  })
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings,
    accounts: accountService,
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    clock: systemClock,
    publicRelayUrl: RELAY_URL,
    // The production union + rebroadcast (container wiring): the enabled
    // gitlab hook set, recompiled through the app's HookService after runs.
    desiredWebhookEvents: async (orgId, projectId) =>
      unionGitlabWebhookEvents(await hookRepo.listForOrgKind(OrgId(orgId), 'gitlab'), projectId),
    onConverged: (orgId, projectId) => {
      const app = running
      if (!app) return
      void hookRepo.listForOrgKind(OrgId(orgId), 'gitlab').then(async (rows) => {
        for (const row of rows) if (row.repoId === projectId) await app.deps.hooks.broadcast(row)
      })
    },
    fetchImpl: fake.fetch()
  })
  running = buildHttpApp(
    prisma,
    { PUBLIC_CP_URL: 'https://api.example.test', PUBLIC_RELAY_URL: RELAY_URL },
    undefined,
    undefined,
    { gitlab: { oauth, provisioner, accounts: accountService, fetchImpl: fake.fetch() } }
  )
  // A live relay row so the ingress gate passes.
  await prisma.relay.create({
    data: {
      id: randomUUID(),
      name: `relay-${randomUUID().slice(0, 8)}`,
      daemonUrl: 'wss://relay-0',
      lastSeenAt: new Date()
    }
  })
  // A ready managed binding for the fake's default project.
  const connection = await connections.upsertOnCallback({
    orgId: DEFAULT_ORG_ID,
    userId: DEFAULT_OWNER_ID,
    gitlabUserId: 4242n,
    gitlabUsername: 'example-admin',
    scopes: ['api'],
    accessExpiresAt: new Date(Date.now() + 3600_000),
    sealedPair: { accessToken: 'at-1', refreshToken: 'rt-1' }
  })
  const binding = await bindings.createWithClaim({
    orgId: DEFAULT_ORG_ID,
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    installerConnectionId: connection.id
  })
  expect(await provisioner.provision(DEFAULT_ORG_ID, binding.id)).toEqual({ state: 'ready' })
  const daemonId = randomUUID()
  await seedDaemon(prisma, daemonId)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId })
  // A second agent, so a test needing two hooks on one project clears the per-agent fence.
  const secondAgentId = randomUUID()
  await seedAgent(prisma, secondAgentId, { daemonId })
  return { fake, a: running, hookRepo, bindings, accounts, provisioner, binding, agentId, secondAgentId }
}

/** A stand-in relay socket. `answer` decides how it replies to a correlated
 *  `rc/hook-rerun`: a result admits or refuses, a throw is an ambiguous relay. */
function channel(features?: string[], answer?: RcHookRerunResult | (() => RcHookRerunResult)) {
  const sent: Array<{ type: string; payload: unknown }> = []
  const requests: Array<{ type: string; payload: unknown }> = []
  const ch = {
    relayId: `r-${randomUUID().slice(0, 8)}`,
    ...(features ? { features } : {}),
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload })
    },
    request: async (type: string, payload: unknown) => {
      requests.push({ type, payload })
      const reply = typeof answer === 'function' ? answer() : answer
      return reply ?? { admitted: true, deliveryKey: (payload as { deliveryKey: string }).deliveryKey }
    },
    close() {}
  } as unknown as RelayChannel
  return { ch, sent, requests }
}

const glBody = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  kind: 'gitlab',
  name: 'gl-hook',
  projectId: PROJECT.toString(),
  events: ['issues:*', 'merge_request:opened'],
  commentFamilies: ['issues', 'merge_request'],
  ...over
})

describe('gitlab hooks — routes, compile, webhook converge (§8.3/§11.1/§11.3)', () => {
  it('create compiles a rule for feature-advertising relays only, and installs the managed webhook', async () => {
    const h = await harness()
    const glab = channel([GITLAB_COM_V1_FEATURE])
    const legacy = channel()
    h.a.relayReg.add(glab.ch)
    h.a.relayReg.add(legacy.ch)

    // The removed label filter is read tolerantly: an old client may still send it.
    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: glBody(h.agentId, { labelFilter: ['bug'] })
    })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { id: string; kind: string; url: string | null }
    expect(dto.kind).toBe('gitlab')

    // The converge kick installs the webhook (§11.1) with the hook's union…
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 20_000 })
    const webhook = [...h.fake.webhooks.values()][0]!
    expect(webhook.url).toBe(`${RELAY_URL}/webhooks/gitlab`)
    expect(webhook.events['issues_events']).toBe(true)
    expect(webhook.events['merge_requests_events']).toBe(true)
    expect(webhook.events['note_events']).toBe(true)
    expect(webhook.events['push_events']).toBeFalsy()

    // …then re-broadcasts the now-complete rule, only to relays advertising the feature (§17.3).
    await vi.waitFor(
      () => {
        const assigns = glab.sent.filter((frame) => frame.type === 'rc/hook-assign')
        expect(assigns.length).toBeGreaterThan(0)
        const rule = assigns.at(-1)!.payload as RcHookAssign
        expect(rule.kind).toBe('gitlab')
        expect(rule.gitlab?.projectId).toBe(PROJECT.toString())
        expect(rule.gitlab?.sessionKeyPrefix).toBe(`gitlab:${PROJECT}`)
        expect(rule.gitlab?.serviceAccountUsername).toBe(
          gitlabAgentAccountUsername(h.agentId, `agent-${h.agentId.slice(0, 4)}`, 900n)
        )
        // §12.1 veto set: every account bound to the project (§7.2).
        expect(rule.gitlab?.boundServiceAccountUserIds).toEqual([rule.gitlab!.serviceAccountUserId])
        expect(rule.gitlab?.signingToken).toBe(webhook.token)
        expect(rule.gitlab?.events).toEqual(['issues:*', 'merge_request:opened'])
        // The value never reaches the rule; the empty array only keeps an older relay decoding.
        expect(rule.gitlab?.labelFilter).toEqual([])
      },
      { timeout: 20_000 }
    )
    expect(legacy.sent.filter((frame) => frame.type === 'rc/hook-assign')).toHaveLength(0)
  })

  it('provisions the hook agent’s account inline, before the write (§7.2)', async () => {
    const h = await harness()
    // The binding converged with no consumers, so it has no accounts at all.
    expect(await h.accounts.listForBinding(h.binding.id)).toHaveLength(0)

    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(200)

    // Asserted with NO polling: the rule this write compiles names the agent's
    // own account, so the account has to exist by the time the write happens.
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, h.agentId, 900n))!
    expect(account.state).toBe('ready')
    expect(account.username).toBe(gitlabAgentAccountUsername(h.agentId, `agent-${h.agentId.slice(0, 4)}`, 900n))
    expect((await h.accounts.membershipsForBinding(h.binding.id)).map((m) => m.accountId)).toEqual([account.id])
    expect(h.fake.members.get(Number(account.serviceAccountUserId))).toBe(30)
  })

  it('rolls back the account a refused hook write speculatively created', async () => {
    // The account is created, then its PATs come back out of policy: the ensure
    // fails with real provider state already behind it, and the hook row that
    // would have made the agent a consumer is never written. Nothing would ever
    // visit that account again, so the write has to undo it (§7.2).
    const h = await harness({ patExpiryOverride: null })
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(409)
    expect(await h.hookRepo.listForAgent(AgentId(h.agentId))).toHaveLength(0)

    // No account row, no service account left in the group, no live token.
    expect(await h.accounts.listForAgent(DEFAULT_ORG_ID, h.agentId)).toHaveLength(0)
    expect(h.fake.serviceAccounts).toHaveLength(0)
    expect([...h.fake.tokens.values()].every((token) => token.revoked)).toBe(true)
  })

  it('keeps a membership another authorization still earns when a hook write is refused', async () => {
    const h = await harness()
    // The agent already consumes the project through its workspace, so the
    // account and membership are not this write's to undo.
    await prisma.agent.update({
      where: { id: h.agentId },
      data: {
        workspaceMode: 'gitlab',
        workspaceRepoId: PROJECT,
        gitRepo: 'https://gitlab.com/example-group/example-project'
      }
    })
    await h.provisioner.convergeProject(DEFAULT_ORG_ID, PROJECT)
    const account = (await h.accounts.byAgentRoot(DEFAULT_ORG_ID, h.agentId, 900n))!

    // Force a re-mint that the provider then answers out of policy, so the
    // hook's own ensure fails with the account already in place.
    await prisma.gitlabProjectCredential.updateMany({
      where: { accountId: account.id },
      data: { providerExpiresAt: new Date(Date.now() - 1_000) }
    })
    h.fake.opts.patExpiryOverride = null
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(409)
    // The workspace's own authorization survives the refused hook write.
    expect(await h.accounts.get(account.id)).not.toBeNull()
    expect((await h.accounts.membershipsForBinding(h.binding.id)).map((m) => m.accountId)).toEqual([account.id])
    expect(h.fake.deletedServiceAccounts).toEqual([])
  })

  it('a hook that will not be enabled needs no account, even out of quota', async () => {
    const h = await harness({ refuseServiceAccountQuota: true })
    // A disabled hook can never fire, so provisioning an identity for it would
    // churn an account the next convergence retires — and would make disabling
    // impossible while the group is out of slots.
    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: glBody(h.agentId, { enabled: false })
    })
    expect(created.statusCode).toBe(200)
    expect(await h.accounts.listForAgent(DEFAULT_ORG_ID, h.agentId)).toHaveLength(0)
    expect(h.fake.serviceAccounts).toHaveLength(0)

    // Disabling an enabled hook is likewise not blocked by the outage.
    h.fake.opts.refuseServiceAccountQuota = false
    const enabled = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: glBody(h.secondAgentId)
    })
    expect(enabled.statusCode).toBe(200)
    h.fake.opts.refuseServiceAccountQuota = true
    const disabled = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${(enabled.json() as { id: string }).id}`,
      payload: { ...glBody(h.secondAgentId), enabled: false }
    })
    expect(disabled.statusCode).toBe(200)
    expect((disabled.json() as { enabled: boolean }).enabled).toBe(false)
  })

  it('refuses the hook with the account’s own repair reason, writing no hook', async () => {
    const h = await harness({ refuseServiceAccountQuota: true })
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(409)
    expect((created.json() as { message: string }).message).toContain('no service-account slots left')
    expect(await h.hookRepo.listForAgent(AgentId(h.agentId))).toHaveLength(0)
    expect(await h.accounts.membershipsForBinding(h.binding.id)).toHaveLength(0)
  })

  it('create is fenced on a managed binding; a second hook on the same project+agent is a 409', async () => {
    const h = await harness()
    const unbound = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: glBody(h.agentId, { projectId: '999' })
    })
    expect(unbound.statusCode).toBe(409)

    expect((await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })).statusCode).toBe(
      200
    )
    const dup = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(dup.statusCode).toBe(409)
  })

  it('delete drops the rule and uninstalls the webhook once no hook wants events (§11.1 inverse)', async () => {
    const h = await harness()
    const glab = channel([GITLAB_COM_V1_FEATURE])
    h.a.relayReg.add(glab.ch)
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    const hookId = (created.json() as { id: string }).id
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 20_000 })

    const res = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${hookId}` })
    expect(res.statusCode).toBe(204)
    await vi.waitFor(
      async () => {
        expect(glab.sent.some((frame) => frame.type === 'rc/hook-remove')).toBe(true)
        expect(h.fake.webhooks.size).toBe(0)
        // The binding record trails the provider delete inside the same kick.
        expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))?.webhookId).toBeNull()
      },
      { timeout: 20_000 }
    )
  })

  it('round-trips the review and reporting axes, defaulting both off', async () => {
    const h = await harness()
    // Default: a body that names neither axis stores the off pair, exactly like github's.
    const plain = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(plain.statusCode).toBe(200)
    const plainRow = (await h.hookRepo.get(OrgId(DEFAULT_ORG_ID), HookId((plain.json() as { id: string }).id)))!
    expect(plainRow.reviewPolicy).toBe('off')
    expect(plainRow.reportingMode).toBe('off')
    expect(plainRow.gateMode).toBe('informational')
    expect((plain.json() as { reviewPolicy: string }).reviewPolicy).toBe('off')

    // A second agent so the one-hook-per-(agent, project) fence does not fire.
    const second = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: glBody(h.secondAgentId, { reviewPolicy: 'full', reportingMode: 'check' })
    })
    expect(second.statusCode).toBe(200)
    const hookId = (second.json() as { id: string }).id
    const row = (await h.hookRepo.get(OrgId(DEFAULT_ORG_ID), HookId(hookId)))!
    expect(row.reviewPolicy).toBe('full')
    expect(row.reportingMode).toBe('check')
    expect(second.json()).toMatchObject({ reviewPolicy: 'full', reportingMode: 'check' })

    // PUT moves one axis and preserves the other; omitting both keeps the stored pair.
    const lowered = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${hookId}`,
      payload: glBody(h.secondAgentId, { reviewPolicy: 'comment', reportingMode: 'check' })
    })
    expect(lowered.statusCode).toBe(200)
    expect((await h.hookRepo.get(OrgId(DEFAULT_ORG_ID), HookId(hookId)))!.reviewPolicy).toBe('comment')

    const echoed = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${hookId}`,
      payload: glBody(h.secondAgentId)
    })
    expect(echoed.statusCode).toBe(200)
    const preserved = (await h.hookRepo.get(OrgId(DEFAULT_ORG_ID), HookId(hookId)))!
    expect(preserved.reviewPolicy).toBe('comment')
    expect(preserved.reportingMode).toBe('check')
  })

  it('refuses commit status reporting, which GitLab does not serve (§16.2)', async () => {
    const h = await harness()
    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: glBody(h.agentId, { reportingMode: 'status' })
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('commit status')
  })

  it('carries the effect axes into the compiled rule fence', async () => {
    const h = await harness()
    const glab = channel([GITLAB_COM_V1_FEATURE])
    h.a.relayReg.add(glab.ch)
    const res = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: glBody(h.agentId, { reviewPolicy: 'request_changes', reportingMode: 'check' })
    })
    expect(res.statusCode).toBe(200)
    await vi.waitFor(
      () => {
        const assigns = glab.sent.filter((frame) => frame.type === 'rc/hook-assign')
        expect(assigns.length).toBeGreaterThan(0)
        const rule = assigns.at(-1)!.payload as RcHookAssign
        expect(rule.reviewPolicy).toBe('request_changes')
        expect(rule.reportingMode).toBe('check')
      },
      { timeout: 20_000 }
    )
  })

  it('update re-fences the project against the org bindings', async () => {
    const h = await harness()
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    const hookId = (created.json() as { id: string }).id

    const retarget = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${hookId}`,
      payload: glBody(h.agentId, { projectId: '999' })
    })
    expect(retarget.statusCode).toBe(409)

    const ok = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${hookId}`,
      payload: glBody(h.agentId, { events: ['push:*'], commentFamilies: [] })
    })
    expect(ok.statusCode).toBe(200)
    const row = (await h.hookRepo.get(OrgId(DEFAULT_ORG_ID), HookId(hookId)))!
    expect(row.events).toEqual(['push:*'])
    // The saga converges the webhook down to the new union.
    await vi.waitFor(
      () => {
        const webhook = [...h.fake.webhooks.values()][0]!
        expect(webhook.events['push_events']).toBe(true)
        expect(webhook.events['issues_events']).toBeFalsy()
      },
      { timeout: 20_000 }
    )
  })
})

describe('gitlab hooks — binding lifecycle rebroadcast (§11.1/§11.3 round 2)', () => {
  it("retargeting the last hook A→B uninstalls A's webhook and installs B's", async () => {
    const h = await harness()
    // A second managed binding (the fake serves any project id it is asked for).
    const OTHER = 999n
    const connection = await prisma.gitlabConnection.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
    const other = await h.bindings.createWithClaim({
      orgId: DEFAULT_ORG_ID,
      projectId: OTHER,
      projectPath: 'example-group/other-project',
      installerConnectionId: connection.id
    })
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, other.id)).toEqual({ state: 'ready' })

    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(200)
    const hookId = (created.json() as { id: string }).id
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 20_000 })

    const moved = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${hookId}`,
      payload: glBody(h.agentId, { projectId: OTHER.toString() })
    })
    expect(moved.statusCode).toBe(200)
    // BOTH bindings converge: A's webhook and key retire, B's install.
    await vi.waitFor(
      async () => {
        expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))?.webhookId).toBeNull()
        expect((await h.bindings.get(DEFAULT_ORG_ID, other.id))?.webhookId).not.toBeNull()
        expect(h.fake.webhooks.size).toBe(1)
      },
      { timeout: 20_000 }
    )
  })

  it('a provider-side webhook loss is healed on the next converge — local columns are not proof', async () => {
    const h = await harness()
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(200)
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 20_000 })
    const staleId = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    // Provider-side deletion (or a crash between the delete and the local
    // clear): the recorded id and desiredEventsHash both survive locally.
    h.fake.webhooks.clear()
    // The create kick's saga may still hold the run lease — retry through it.
    await vi.waitFor(
      async () => expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' }),
      { timeout: 20_000 }
    )
    expect(h.fake.webhooks.size).toBe(1)
    const healed = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    expect(healed).not.toBe(staleId)
    expect([...h.fake.webhooks.keys()][0]).toBe(Number(healed))
  })

  it('repair rebroadcasts the project rules with the STABLE signing key', async () => {
    const h = await harness()
    const glab = channel([GITLAB_COM_V1_FEATURE])
    h.a.relayReg.add(glab.ch)
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(200)
    let firstToken = ''
    await vi.waitFor(
      () => {
        const assigns = glab.sent.filter((frame) => frame.type === 'rc/hook-assign')
        expect(assigns.length).toBeGreaterThan(0)
        firstToken = (assigns.at(-1)!.payload as RcHookAssign).gitlab!.signingToken
      },
      { timeout: 20_000 }
    )

    glab.sent.length = 0
    const repair = await h.a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${h.binding.id}/repair` })
    expect(repair.statusCode).toBe(200)
    // The saga's onConverged re-pushes the compiled rule; the key is reused,
    // never rotated, so live rules stay verifiable across repairs.
    await vi.waitFor(
      () => {
        const assigns = glab.sent.filter((frame) => frame.type === 'rc/hook-assign')
        expect(assigns.length).toBeGreaterThan(0)
        expect((assigns.at(-1)!.payload as RcHookAssign).gitlab!.signingToken).toBe(firstToken)
      },
      { timeout: 20_000 }
    )
    expect([...h.fake.webhooks.values()][0]!.token).toBe(firstToken)
  })
})

describe('rc/codehost-membership-authz (§12.2)', () => {
  async function authzHarness() {
    const h = await harness()
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(200)
    const hookRow = (await h.hookRepo.get(OrgId(DEFAULT_ORG_ID), HookId((created.json() as { id: string }).id)))!
    // The hook made its agent a consumer: wait for the converge kick to give it
    // its own account, since the live authorization resolves through that account.
    await vi.waitFor(async () => expect(await h.accounts.listForBinding(h.binding.id)).toHaveLength(1), {
      timeout: 20_000
    })
    const service = new GitlabMembershipAuthzService({
      hooks: h.hookRepo,
      bindings: h.bindings,
      accounts: h.accounts,
      credentials: new PgGitlabProjectCredentialRepo(prisma),
      credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
      clock: systemClock,
      fetchImpl: h.fake.fetch()
    })
    const base = {
      hookId: hookRow.id,
      provider: 'gitlab',
      repoExternalId: PROJECT.toString(),
      actorExternalId: '7001',
      configRevision: hookRow.configRevision.toString(),
      dispatchRevision: hookRow.dispatchRevision.toString()
    }
    return { h, hookRow, service, base }
  }

  it('allows a live Developer, denies below-bar, unknown, and expired-fence actors', async () => {
    const { h, service, base } = await authzHarness()
    h.fake.members.set(7001, 30)
    h.fake.members.set(7002, 20)
    expect(await service.allowed(base)).toBe(true)
    expect(await service.allowed({ ...base, actorExternalId: '7002' })).toBe(false)
    expect(await service.allowed({ ...base, actorExternalId: '7999' })).toBe(false)
    // Unmentioned thread continuation: the subject author must ALSO hold the bar.
    expect(await service.allowed({ ...base, subjectAuthorExternalId: '7002' })).toBe(false)
    expect(await service.allowed({ ...base, subjectAuthorExternalId: '7001' })).toBe(true)
  })

  it('never authorizes the managed service account, a stale fence, a foreign provider, or a disabled hook', async () => {
    const { h, hookRow, service, base } = await authzHarness()
    h.fake.members.set(7001, 30)
    // The agent's own account holds a project role by §7.2, but its identity must not summon (§12.1 belt).
    const saId = (await h.accounts.listForBinding(h.binding.id))[0]!.serviceAccountUserId!.toString()
    expect(await service.allowed({ ...base, actorExternalId: saId })).toBe(false)
    expect(await service.allowed({ ...base, configRevision: (hookRow.configRevision + 1n).toString() })).toBe(false)
    expect(await service.allowed({ ...base, provider: 'github' })).toBe(false)
    await prisma.hookDef.update({ where: { id: hookRow.id }, data: { enabled: false } })
    expect(await service.allowed(base)).toBe(false)
  })
})

describe('gitlab hook rerun — the Console "Run again" route (§16.1/§18.2)', () => {
  const MR_IID = 42
  const CURRENT_HEAD = 'cafebabe0000000000000000000000000000cafe'
  const RERUN_FEATURES = [GITLAB_COM_V1_FEATURE, GITLAB_RERUN_V1_FEATURE]

  async function rerunHarness(answer?: RcHookRerunResult | (() => RcHookRerunResult)) {
    const h = await harness()
    const glab = channel(RERUN_FEATURES, answer)
    h.a.relayReg.add(glab.ch)
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(200)
    const hookId = (created.json() as { id: string }).id
    // The create kick installs the managed webhook; until it lands the hook has
    // no compilable rule and every rerun is correctly refused.
    await vi.waitFor(
      () => {
        expect(h.fake.webhooks.size).toBe(1)
        expect(glab.sent.some((frame) => frame.type === 'rc/hook-assign')).toBe(true)
      },
      { timeout: 20_000 }
    )
    // The subject as GitLab reports it NOW — a stale stored head must never win.
    h.fake.mergeRequests.set(MR_IID, {
      state: 'opened',
      headSha: CURRENT_HEAD,
      baseSha: 'ba5e0000000000000000000000000000000ba5e0'
    })
    glab.sent.length = 0
    return { h, glab, hookId }
  }

  const rerun = (a: HttpApp, hookId: string, subject: Record<string, unknown>) =>
    a.app.inject({ method: 'POST', url: `${ORG}/hooks/${hookId}/rerun`, payload: { subject } })

  const reruns = (frames: Array<{ type: string; payload: unknown }>) =>
    frames.filter((frame) => frame.type === 'rc/hook-rerun').map((frame) => frame.payload as RcHookRerun)

  const runsFor = (hookId: string) => prisma.hookRun.findMany({ where: { hookId } })

  it('re-dispatches the current head to ONE feature-advertising relay', async () => {
    const { h, glab, hookId } = await rerunHarness()
    const legacy = channel([GITLAB_COM_V1_FEATURE])
    h.a.relayReg.add(legacy.ch)
    // A stale head in the request body is impossible by construction: the caller
    // names only the subject, and the CP reads the revision itself.
    const res = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { accepted: boolean; deliveryKey: string; event: string; headSha: string }
    expect(body.accepted).toBe(true)
    expect(body.event).toBe('merge_request:rerun')
    expect(body.headSha).toBe(CURRENT_HEAD)

    const frames = reruns(glab.requests)
    expect(frames).toHaveLength(1)
    const frame = frames[0]!
    expect(frame.hookId).toBe(hookId)
    expect(frame.agentId).toBe(h.agentId)
    expect(frame.deliveryKey).toBe(body.deliveryKey)
    expect(frame.gitlab.projectId).toBe(PROJECT.toString())
    expect(frame.gitlab.target).toMatchObject({ kind: 'merge_request', iid: MR_IID, headSha: CURRENT_HEAD })
    // The fence the relay re-checks against its own compiled rule.
    const row = (await h.hookRepo.get(OrgId(DEFAULT_ORG_ID), HookId(hookId)))!
    expect(frame.configRevision).toBe(row.configRevision.toString())
    expect(frame.dispatchRevision).toBe(row.dispatchRevision.toString())
    // One click is one turn: the frame goes to exactly one relay, and never to a
    // relay whose advertised features predate it.
    expect(reruns(legacy.requests)).toHaveLength(0)
    expect(reruns(glab.sent)).toHaveLength(0)
  })

  it('follows the head between reruns instead of pinning the first one', async () => {
    const { h, glab, hookId } = await rerunHarness()
    expect((await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })).statusCode).toBe(200)
    h.fake.mergeRequests.set(MR_IID, { state: 'opened', headSha: 'f00d'.repeat(10) })
    const second = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(second.statusCode).toBe(200)
    expect((second.json() as { headSha: string }).headSha).toBe('f00d'.repeat(10))
    const frames = reruns(glab.requests)
    expect(frames).toHaveLength(2)
    expect(frames.map((frame) => (frame.gitlab.target as { headSha?: string }).headSha)).toEqual([
      CURRENT_HEAD,
      'f00d'.repeat(10)
    ])
    // Each rerun opens its own run row.
    expect(new Set(frames.map((frame) => frame.deliveryKey)).size).toBe(2)
  })

  it('runs an issue subject with no head, and refuses a closed or deleted one', async () => {
    const { h, glab, hookId } = await rerunHarness()
    h.fake.issues.set(7, { state: 'opened' })
    h.fake.issues.set(8, { state: 'closed' })

    const open = await rerun(h.a, hookId, { kind: 'issue', iid: 7 })
    expect(open.statusCode).toBe(200)
    expect((open.json() as { headSha: string | null; event: string }).headSha).toBeNull()
    expect((open.json() as { event: string }).event).toBe('issues:rerun')
    expect(reruns(glab.requests)[0]!.gitlab.target).toEqual({ kind: 'issue', iid: 7 })

    const closed = await rerun(h.a, hookId, { kind: 'issue', iid: 8 })
    expect(closed.statusCode).toBe(409)
    expect((closed.json() as { code: string }).code).toBe('SUBJECT_CLOSED')

    const gone = await rerun(h.a, hookId, { kind: 'issue', iid: 9 })
    expect(gone.statusCode).toBe(409)
    expect((gone.json() as { code: string }).code).toBe('SUBJECT_NOT_FOUND')

    // A merged merge request is equally not a new generation.
    h.fake.mergeRequests.set(MR_IID, { state: 'merged', headSha: CURRENT_HEAD })
    const merged = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(merged.statusCode).toBe(409)
    expect((merged.json() as { code: string }).code).toBe('SUBJECT_CLOSED')
    expect(reruns(glab.requests)).toHaveLength(1)
  })

  it('reads an unknown and a cross-organization hook as absent', async () => {
    const { h, glab, hookId } = await rerunHarness()
    expect((await rerun(h.a, randomUUID(), { kind: 'merge_request', iid: MR_IID })).statusCode).toBe(404)

    const foreignOrg = `foreign-${randomUUID().slice(0, 8)}`
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    await prisma.hookDef.update({ where: { id: hookId }, data: { orgId: foreignOrg } })
    const cross = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(cross.statusCode).toBe(404)
    // No existence oracle: the same shape as a hook that never existed.
    expect((cross.json() as { code?: string }).code).toBeUndefined()
    expect(reruns(glab.requests)).toHaveLength(0)
  })

  it('refuses a disabled trigger and a non-gitlab kind', async () => {
    const { h, glab, hookId } = await rerunHarness()
    await prisma.hookDef.update({ where: { id: hookId }, data: { enabled: false } })
    const disabled = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(disabled.statusCode).toBe(409)
    expect((disabled.json() as { code: string }).code).toBe('HOOK_DISABLED')

    const webhook = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: { agentId: h.agentId, kind: 'webhook', name: 'plain-hook' }
    })
    expect(webhook.statusCode).toBe(200)
    const wrongKind = await rerun(h.a, (webhook.json() as { id: string }).id, { kind: 'merge_request', iid: MR_IID })
    expect(wrongKind.statusCode).toBe(409)
    expect((wrongKind.json() as { code: string }).code).toBe('HOOK_NOT_GITLAB')
    expect(reruns(glab.requests)).toHaveLength(0)
  })

  it('refuses a paused agent, a torn-down binding, and a pool with no relay to carry it', async () => {
    const { h, glab, hookId } = await rerunHarness()
    const pause = async (value: boolean) =>
      h.a.app.inject({ method: 'PATCH', url: `${ORG}/agents/${h.agentId}`, payload: { pause: value } })
    expect((await pause(true)).statusCode).toBe(200)
    const paused = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(paused.statusCode).toBe(409)
    expect((paused.json() as { code: string }).code).toBe('AGENT_UNAVAILABLE')
    expect((await pause(false)).statusCode).toBe(200)

    await h.bindings.update(DEFAULT_ORG_ID, h.binding.id, { state: 'cleanup_pending' })
    const unbound = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(unbound.statusCode).toBe(409)
    expect((unbound.json() as { code: string }).code).toBe('BINDING_INACTIVE')
    await h.bindings.update(DEFAULT_ORG_ID, h.binding.id, { state: 'ready' })

    // Nothing reached the pool through any refusal above.
    expect(reruns(glab.requests)).toHaveLength(0)
    // …and with no relay connected at all there is nowhere to dispatch.
    h.a.relayReg.remove(glab.ch.relayId, glab.ch)
    const nowhere = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(nowhere.statusCode).toBe(503)
    expect((nowhere.json() as { code: string }).code).toBe('RELAY_UNAVAILABLE')
  })

  it('treats a relay that only advertises gitlab-com-v1 as no relay at all (§17.3)', async () => {
    const { h, hookId } = await rerunHarness()
    // Drop the rerun-capable relay; only the older one is left.
    for (const ch of h.a.relayReg.all()) h.a.relayReg.remove(ch.relayId, ch)
    const legacy = channel([GITLAB_COM_V1_FEATURE])
    h.a.relayReg.add(legacy.ch)

    const res = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(res.statusCode).toBe(503)
    expect((res.json() as { code: string }).code).toBe('RELAY_UNAVAILABLE')
    // The undecodable frame never reached it, on either leg.
    expect(reruns(legacy.requests)).toHaveLength(0)
    expect(reruns(legacy.sent)).toHaveLength(0)
    expect(await runsFor(hookId)).toHaveLength(0)
  })

  // Each definitive refusal gets its own case: the deployment-global project
  // claim only clears with the per-test truncation, so one harness per test.
  for (const [code, status] of [
    ['replay_pending', 503],
    ['rule_mismatch', 409],
    ['limiter_exhausted', 429]
  ] as const) {
    it(`returns a ${code} refusal as-is without asking another relay`, async () => {
      const { h, glab, hookId } = await rerunHarness({ admitted: false, code })
      // A peer's rule table converges on its own schedule: after a disable or a
      // revision bump it may still hold the replica this refusal reflects being
      // gone. Asking it would dispatch under revoked authority.
      const spare = channel(RERUN_FEATURES)
      h.a.relayReg.add(spare.ch)

      const res = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
      expect(res.statusCode).toBe(status)
      const body = res.json() as { code: string; message: string }
      expect(body.code).toBe('RELAY_REJECTED')
      // Human prose, never the wire category.
      expect(body.message).not.toContain(code)
      // The relay WAS asked — and answered no. Its verdict is final.
      expect(reruns(glab.requests)).toHaveLength(1)
      expect(reruns(spare.requests)).toHaveLength(0)
      expect(await runsFor(hookId)).toHaveLength(0)
    })
  }

  it('stops at a relay that went quiet after the frame was written', async () => {
    const { h, hookId } = await rerunHarness()
    // A relay that answers nothing may already have dispatched, so the walk ends
    // there rather than risking a second turn on the same delivery key.
    const quiet = channel(RERUN_FEATURES, () => {
      throw new Error('socket closed mid-request')
    })
    for (const ch of h.a.relayReg.all()) h.a.relayReg.remove(ch.relayId, ch)
    h.a.relayReg.add(quiet.ch)
    const spare = channel(RERUN_FEATURES)
    h.a.relayReg.add(spare.ch)

    const res = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(res.statusCode).toBe(503)
    expect((res.json() as { code: string }).code).toBe('RELAY_AMBIGUOUS')
    expect(reruns(quiet.requests)).toHaveLength(1)
    expect(reruns(spare.requests)).toHaveLength(0)
  })

  it('moves to the next relay only when the frame never reached the wire', async () => {
    const { h, hookId } = await rerunHarness()
    // Nothing was written, so nothing could have been admitted — unlike a lost
    // answer, this leaves the next relay safe to ask.
    const dead = channel(RERUN_FEATURES, () => {
      throw new RelayNotWritten('relay is CLOSED')
    })
    for (const ch of h.a.relayReg.all()) h.a.relayReg.remove(ch.relayId, ch)
    h.a.relayReg.add(dead.ch)
    const live = channel(RERUN_FEATURES)
    h.a.relayReg.add(live.ch)

    const res = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(res.statusCode).toBe(200)
    expect(reruns(dead.requests)).toHaveLength(1)
    expect(reruns(live.requests)).toHaveLength(1)

    // Every relay unwritable ⇒ nothing was asked at all.
    for (const ch of h.a.relayReg.all()) h.a.relayReg.remove(ch.relayId, ch)
    h.a.relayReg.add(
      channel(RERUN_FEATURES, () => {
        throw new RelayNotWritten('relay is CLOSED')
      }).ch
    )
    const none = await rerun(h.a, hookId, { kind: 'merge_request', iid: MR_IID })
    expect(none.statusCode).toBe(503)
    expect((none.json() as { code: string }).code).toBe('RELAY_UNAVAILABLE')
  })
})
