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
import { GitlabMembershipAuthzService } from '../../src/gitlab/membership-authz.service.js'
import { unionGitlabWebhookEvents } from '../../src/gitlab/webhook-events.js'
import {
  PgCodeHostRepositoryRepo,
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
import { HookId, OrgId } from '../../src/domain/ids.js'
import { GITLAB_COM_V1_FEATURE, type RcHookAssign } from '@agentconnect.md/protocol'
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
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings,
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    cipher,
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
    { gitlab: { oauth, provisioner, fetchImpl: fake.fetch() } }
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
  return { fake, a: running, hookRepo, bindings, provisioner, binding, agentId }
}

function channel(features?: string[]) {
  const sent: Array<{ type: string; payload: unknown }> = []
  const ch = {
    relayId: `r-${randomUUID().slice(0, 8)}`,
    ...(features ? { features } : {}),
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload })
    },
    close() {}
  } as unknown as RelayChannel
  return { ch, sent }
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

    const res = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { id: string; kind: string; url: string | null }
    expect(dto.kind).toBe('gitlab')

    // The converge kick installs the webhook (§11.1) with the hook's union…
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 15_000 })
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
        expect(rule.gitlab?.serviceAccountUsername).toBe(`agentconnect-p${PROJECT}`)
        expect(rule.gitlab?.signingToken).toBe(webhook.token)
        expect(rule.gitlab?.events).toEqual(['issues:*', 'merge_request:opened'])
      },
      { timeout: 15_000 }
    )
    expect(legacy.sent.filter((frame) => frame.type === 'rc/hook-assign')).toHaveLength(0)
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
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 15_000 })

    const res = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${hookId}` })
    expect(res.statusCode).toBe(204)
    await vi.waitFor(
      async () => {
        expect(glab.sent.some((frame) => frame.type === 'rc/hook-remove')).toBe(true)
        expect(h.fake.webhooks.size).toBe(0)
        // The binding record trails the provider delete inside the same kick.
        expect((await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))?.webhookId).toBeNull()
      },
      { timeout: 15_000 }
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
      { timeout: 15_000 }
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
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 15_000 })

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
      { timeout: 15_000 }
    )
  })

  it('a provider-side webhook loss is healed on the next converge — local columns are not proof', async () => {
    const h = await harness()
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: glBody(h.agentId) })
    expect(created.statusCode).toBe(200)
    await vi.waitFor(() => expect(h.fake.webhooks.size).toBe(1), { timeout: 15_000 })
    const staleId = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.webhookId!
    // Provider-side deletion (or a crash between the delete and the local
    // clear): the recorded id and desiredEventsHash both survive locally.
    h.fake.webhooks.clear()
    expect(await h.provisioner.provision(DEFAULT_ORG_ID, h.binding.id)).toEqual({ state: 'ready' })
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
      { timeout: 15_000 }
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
      { timeout: 15_000 }
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
    const service = new GitlabMembershipAuthzService({
      hooks: h.hookRepo,
      bindings: h.bindings,
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
    // The SA holds Developer by §7.2, but its identity must not summon (§12.1 belt).
    const saId = (await h.bindings.get(DEFAULT_ORG_ID, h.binding.id))!.serviceAccountUserId!.toString()
    expect(await service.allowed({ ...base, actorExternalId: saId })).toBe(false)
    expect(await service.allowed({ ...base, configRevision: (hookRow.configRevision + 1n).toString() })).toBe(false)
    expect(await service.allowed({ ...base, provider: 'github' })).toBe(false)
    await prisma.hookDef.update({ where: { id: hookRow.id }, data: { enabled: false } })
    expect(await service.allowed(base)).toBe(false)
  })
})
