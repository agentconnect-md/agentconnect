/**
 * GitLab OAuth connection routes (gitlab-com-integration.md §9, §18.2):
 * start → begin → callback over real Pg stores with a stubbed gitlab.com edge,
 * metadata-only DTOs, single-use state, browser binding, and disconnect.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { OrgId } from '../../src/domain/ids.js'
import { unionGitlabWebhookEvents } from '../../src/gitlab/webhook-events.js'
import {
  PgGitlabAgentAccountRepo,
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabOauthStateStore,
  PgGitlabProjectBindingRepo,
  PgGitlabProjectCredentialRepo,
  PgGitlabProjectCredentialSecretStore,
  PgGitlabWebhookSecretStore
} from '../../src/persistence/repositories/gitlab.repo.js'
import { PgCodeHostRepositoryRepo } from '../../src/persistence/repositories/code-host-repository.repo.js'
import { GitlabProvisioner } from '../../src/gitlab/provisioner.js'
import { GitlabAccountService } from '../../src/gitlab/account.service.js'
import { gitlabAgentAccountUsername } from '../../src/gitlab/api.js'
import { FakeGitlab, type FakeGitlabOptions } from '../fakes/gitlab-api.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PUBLIC_CP = 'https://api.example.test'

const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function gitlabApp(
  options: FakeGitlabOptions = {},
  callerUserId?: string,
  /** A deployment with no public webhook address makes the webhook step fail for real. */
  deployment: { publicRelayUrl?: string } = {}
): HttpApp & { fake: FakeGitlab } {
  const fake = new FakeGitlab(options)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1', baseUrl: fake.opts.baseUrl },
    connections: new PgGitlabConnectionRepo(prisma),
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    cipher,
    clock: systemClock,
    publicCpUrl: PUBLIC_CP,
    webAppUrl: 'https://console.example.test',
    api: fake.api
  })
  const accountService = new GitlabAccountService({
    oauth,
    accounts: new PgGitlabAgentAccountRepo(prisma),
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    agents: new PgAgentRepo(prisma),
    cipher,
    clock: systemClock,
    api: fake.api
  })
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings: new PgGitlabProjectBindingRepo(prisma),
    accounts: accountService,
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    clock: systemClock,
    publicRelayUrl: deployment.publicRelayUrl ?? 'https://relay.example.test',
    // The same authority container.ts wires: an enabled gitlab hook on the project wants ingress.
    desiredWebhookEvents: async (orgId, projectId) =>
      unionGitlabWebhookEvents(await new PgHookRepo(prisma).listForOrgKind(OrgId(orgId), 'gitlab'), projectId),
    api: fake.api
  })
  running = buildHttpApp(
    prisma,
    { PUBLIC_CP_URL: PUBLIC_CP, ...(callerUserId ? { DEFAULT_OWNER_ID: callerUserId } : {}) },
    undefined,
    undefined,
    { gitlab: { oauth, provisioner, accounts: accountService, api: fake.api } }
  )
  return { ...running, fake }
}

async function connect(a: HttpApp): Promise<{ connectionId: string }> {
  const started = await a.app.inject({
    method: 'POST',
    url: `${ORG}/gitlab/oauth/start`,
    payload: { returnPath: '/settings/integrations' }
  })
  expect(started.statusCode).toBe(200)
  const { url } = started.json() as { url: string }
  expect(url.startsWith(`${PUBLIC_CP}/v1/gitlab/oauth/begin?state=`)).toBe(true)
  const state = new URL(url).searchParams.get('state')!

  const begun = await a.app.inject({ method: 'GET', url: `/api/v1/gitlab/oauth/begin?state=${state}` })
  expect(begun.statusCode).toBe(302)
  const authorize = new URL(begun.headers.location as string)
  expect(authorize.origin).toBe('https://gitlab.com')
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  const cookie = (begun.headers['set-cookie'] as string).split(';')[0]!

  const done = await a.app.inject({
    method: 'GET',
    url: `/api/v1/gitlab/oauth/callback?state=${state}&code=code-1`,
    headers: { cookie }
  })
  expect(done.statusCode).toBe(302)
  expect(done.headers.location).toBe('https://console.example.test/settings/integrations?gitlab=connected')

  // Replay of the consumed state fails closed with a uniform result.
  const replay = await a.app.inject({
    method: 'GET',
    url: `/api/v1/gitlab/oauth/callback?state=${state}&code=code-1`,
    headers: { cookie }
  })
  expect((replay.headers.location as string).endsWith('gitlab=state_invalid')).toBe(true)

  const row = await prisma.gitlabConnection.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
  return { connectionId: row.id }
}

/** One agent consuming the project, so convergence gives it a service account (§7.2). */
async function seedConsumer(): Promise<void> {
  await seedAgent(prisma, randomUUID(), { name: `gl-${randomUUID().slice(0, 6)}`, gitlabProjectId: 4455667n })
}

/** The §9.4 starting point: the installing user left, so the binding degrades. */
async function degradedBinding(a: HttpApp & { fake: FakeGitlab }): Promise<{ bindingId: string; installer: string }> {
  const { connectionId } = await connect(a)
  await seedConsumer()
  const bound = await a.app.inject({
    method: 'POST',
    url: `${ORG}/gitlab/projects`,
    payload: { connectionId, projectId: '4455667' }
  })
  expect(bound.statusCode).toBe(200)
  const bindingId = (bound.json() as { id: string }).id
  await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/connections/${connectionId}` })
  // The installing user is no longer an organization member: their OAuth authority does not survive it.
  await prisma.gitlabConnection.update({ where: { id: connectionId }, data: { userId: null } })
  const repaired = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/repair` })
  expect((repaired.json() as { state: string }).state).toBe('admin_degraded')
  return { bindingId, installer: connectionId }
}

/** A second GitLab identity connected by the CALLER, at the given project access level. */
async function ownConnection(fake: FakeGitlab, accessLevel: number): Promise<{ id: string }> {
  fake.members.set(7007, accessLevel)
  return new PgGitlabConnectionRepo(prisma).upsertOnCallback({
    orgId: DEFAULT_ORG_ID,
    userId: DEFAULT_OWNER_ID,
    gitlabUserId: 7007n,
    gitlabUsername: 'example-successor',
    scopes: ['api'],
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    sealedPair: { accessToken: 'at-taker', refreshToken: 'rt-taker' },
    axisBaseUrl: 'https://gitlab.com'
  })
}

const membershipRead = (userId: number, token: string) => ({
  method: 'GET',
  url: `https://gitlab.com/api/v4/projects/4455667/members/all/${userId}`,
  token
})

describe('gitlab project takeover (§9.4)', () => {
  it('moves administration to the caller, verified through the caller’s own token', async () => {
    const a = gitlabApp()
    const { bindingId } = await degradedBinding(a)
    const taker = await ownConnection(a.fake, 50)
    a.fake.requests.length = 0

    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(res.statusCode).toBe(200)
    // Provider truth was re-verified under the new administering account.
    expect(res.json()).toMatchObject({
      id: bindingId,
      state: 'ready',
      stateReason: null,
      installerConnectionId: taker.id
    })
    const row = await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: bindingId } })
    expect(row.installerConnectionId).toBe(taker.id)

    // The Maintainer proof is the CALLER's identity read with the CALLER's token…
    expect(a.fake.requests).toContainEqual(membershipRead(7007, 'at-taker'))
    // …and the released installer's own token is never spent on this route.
    expect(a.fake.requests.every((request) => request.token === 'at-taker')).toBe(true)
    // The claim is left free for the next run: the takeover held it, it did not keep it.
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitlab', externalId: 4455667n } }
    })
    expect(claim.opOwner).toBeNull()
  })

  it('404s a binding of another organization', async () => {
    const a = gitlabApp()
    await connect(a)
    await ownConnection(a.fake, 50)
    const foreignOrg = await prisma.org.create({ data: { name: 'Foreign', slug: 'foreign-gitlab' } })
    const foreign = await prisma.gitlabProjectBinding.create({
      data: {
        orgId: foreignOrg.id,
        projectId: 991122n,
        projectPath: 'example-group/foreign-project',
        state: 'admin_degraded'
      }
    })
    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${foreign.id}/transfer` })
    expect(res.statusCode).toBe(404)
    // A cross-organization takeover never even reaches gitlab.com.
    expect(a.fake.requests.some((request) => request.url.includes('991122'))).toBe(false)
    const untouched = await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: foreign.id } })
    expect(untouched.installerConnectionId).toBeNull()
  })

  it('refuses a caller with no GitLab connection of their own', async () => {
    const a = gitlabApp()
    const { bindingId, installer } = await degradedBinding(a)
    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'GITLAB_NO_OWN_CONNECTION' })
    const row = await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: bindingId } })
    expect(row.installerConnectionId).toBe(installer)
  })

  it('refuses a caller whose own connection needs reconnecting', async () => {
    const a = gitlabApp()
    const { bindingId } = await degradedBinding(a)
    const taker = await ownConnection(a.fake, 50)
    await prisma.gitlabConnection.update({ where: { id: taker.id }, data: { state: 'reauth_required' } })
    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'GITLAB_CONNECTION_NOT_CONNECTED' })
  })

  it('refuses a caller who is only a Developer on the project (§10.1)', async () => {
    const a = gitlabApp()
    const { bindingId, installer } = await degradedBinding(a)
    await ownConnection(a.fake, 30)
    a.fake.requests.length = 0

    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'GITLAB_NOT_MAINTAINER' })
    // The live read happened; the write did not.
    expect(a.fake.requests).toContainEqual(membershipRead(7007, 'at-taker'))
    const row = await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: bindingId } })
    expect(row.installerConnectionId).toBe(installer)
    expect(row.state).toBe('admin_degraded')
  })

  it('refuses while a peer holds the provisioning lease, spending no gitlab call', async () => {
    const a = gitlabApp()
    const { bindingId, installer } = await degradedBinding(a)
    await ownConnection(a.fake, 50)
    await prisma.codeHostRepositoryClaim.updateMany({
      where: { provider: 'gitlab', externalId: 4455667n },
      data: { opOwner: 'peer-run', opLeaseUntil: new Date(Date.now() + 60_000) }
    })
    a.fake.requests.length = 0

    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'GITLAB_BINDING_BUSY' })
    expect(a.fake.requests).toEqual([])
    const row = await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: bindingId } })
    expect(row.installerConnectionId).toBe(installer)
    // The peer's lease is intact: a refused takeover never releases someone else's fence.
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitlab', externalId: 4455667n } }
    })
    expect(claim.opOwner).toBe('peer-run')
  })

  it('breaks the removal deadlock: cleanup_pending transfers, then removal completes', async () => {
    const a = gitlabApp()
    const { bindingId } = await degradedBinding(a)
    // Removal with a released installer cannot reach GitLab: the binding half-leaves.
    const stuck = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/projects/${bindingId}` })
    expect(stuck.json()).toMatchObject({ removed: false, state: 'cleanup_pending', stateReason: 'cleanup_failed' })
    expect(a.fake.serviceAccounts).toHaveLength(1)

    const taker = await ownConnection(a.fake, 50)
    const moved = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(moved.statusCode).toBe(200)
    // A binding on its way out is reassigned, never re-provisioned back to ready.
    expect(moved.json()).toMatchObject({ state: 'cleanup_pending', installerConnectionId: taker.id })

    const removed = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/projects/${bindingId}` })
    expect(removed.json()).toEqual({ removed: true })
    expect(a.fake.serviceAccounts).toHaveLength(0)
    expect(await prisma.gitlabProjectBinding.count({ where: { id: bindingId } })).toBe(0)
    // Verified-complete cleanup frees the project for another organization.
    expect(await prisma.codeHostRepositoryClaim.count({ where: { externalId: 4455667n } })).toBe(0)
  })

  it('takes over a project awaiting cleanup even while its installer still reads connected', async () => {
    // A revoke that fails leaves cleanup_pending under a perfectly connected account:
    // gating on the installer's state alone would answer GITLAB_INSTALLER_CONNECTED here.
    const a = gitlabApp({ failTokenRevoke: true })
    const { connectionId } = await connect(a)
    await seedConsumer()
    const bound = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    const bindingId = (bound.json() as { id: string }).id
    const stuck = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/projects/${bindingId}` })
    expect(stuck.json()).toMatchObject({ removed: false, state: 'cleanup_pending' })
    const installer = await prisma.gitlabConnection.findUniqueOrThrow({ where: { id: connectionId } })
    expect(installer.state).toBe('connected')

    const taker = await ownConnection(a.fake, 50)
    const moved = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(moved.statusCode).toBe(200)
    expect(moved.json()).toMatchObject({ state: 'cleanup_pending', installerConnectionId: taker.id })

    // Under the account that took it over — and a provider that answers — removal finishes.
    a.fake.opts.failTokenRevoke = false
    const removed = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/projects/${bindingId}` })
    expect(removed.json()).toEqual({ removed: true })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { externalId: 4455667n } })).toBe(0)
  })

  it('refuses a project a connected account still administers', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const bound = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    const bindingId = (bound.json() as { id: string }).id
    await ownConnection(a.fake, 50)
    a.fake.requests.length = 0

    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/transfer` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'GITLAB_INSTALLER_CONNECTED' })
    expect(a.fake.requests).toEqual([])
    const row = await prisma.gitlabProjectBinding.findUniqueOrThrow({ where: { id: bindingId } })
    expect(row.installerConnectionId).toBe(connectionId)
  })
})

describe('gitlab oauth routes', () => {
  it('runs start → begin → callback and lists metadata-only connections', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)

    const list = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/connections` })
    expect(list.statusCode).toBe(200)
    const body = list.json() as { connections: Record<string, unknown>[] }
    expect(body.connections).toHaveLength(1)
    expect(body.connections[0]).toMatchObject({
      id: connectionId,
      gitlabUserId: '4242',
      gitlabUsername: 'example-admin',
      state: 'connected',
      scopes: ['api'],
      mine: true
    })
    // Metadata only: no token-shaped field leaves the DTO.
    expect(JSON.stringify(body)).not.toContain('at-1')
    expect(JSON.stringify(body)).not.toContain('rt-1')
    // The pair itself landed sealed in the side-table.
    const secret = await prisma.gitlabConnectionSecret.findUniqueOrThrow({ where: { connectionId } })
    expect(secret.accessToken).toBeTruthy()
  })

  it('reports a connection whose user left the organization as nobody’s own', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    await prisma.gitlabConnection.update({ where: { id: connectionId }, data: { userId: null } })
    const list = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/connections` })
    // `mine` is what the console keys its own-account connect affordance on.
    expect((list.json() as { connections: { mine: boolean }[] }).connections[0]).toMatchObject({ mine: false })
  })

  it('requires the begin-hop browser cookie on the callback', async () => {
    const a = gitlabApp()
    const started = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/oauth/start`, payload: {} })
    const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!
    const begun = await a.app.inject({ method: 'GET', url: `/api/v1/gitlab/oauth/begin?state=${state}` })
    expect(begun.statusCode).toBe(302)
    const done = await a.app.inject({ method: 'GET', url: `/api/v1/gitlab/oauth/callback?state=${state}&code=code-1` })
    expect((done.headers.location as string).endsWith('gitlab=browser_mismatch')).toBe(true)
    expect(await prisma.gitlabConnection.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(0)
  })

  it('rejects a non-local return path', async () => {
    const a = gitlabApp()
    const res = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/oauth/start`,
      payload: { returnPath: 'https://attacker.example.test/' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('disconnects: pair removed, row kept as history', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const res = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/connections/${connectionId}` })
    expect(res.statusCode).toBe(200)
    // A live connection is released, never removed: the row survives for takeover.
    expect(res.json()).toMatchObject({ removed: false, connection: { state: 'disconnected' } })
    expect(await prisma.gitlabConnectionSecret.findUnique({ where: { connectionId } })).toBeNull()
    expect(await prisma.gitlabConnection.count({ where: { id: connectionId } })).toBe(1)
  })

  it('removes a released connection that administers no project (§9.4)', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/connections/${connectionId}` })
    const res = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/connections/${connectionId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ removed: true, connection: null })
    expect(await prisma.gitlabConnection.count({ where: { id: connectionId } })).toBe(0)
    const list = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/connections` })
    expect((list.json() as { connections: unknown[] }).connections).toHaveLength(0)
  })

  it('refuses to remove a released connection while it still administers projects', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const bound = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    expect(bound.statusCode).toBe(200)
    // The list states the blocking count before the user reaches for removal.
    const listed = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/connections` })
    expect((listed.json() as { connections: { assignedProjects: number }[] }).connections[0]).toMatchObject({
      assignedProjects: 1
    })

    await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/connections/${connectionId}` })
    const res = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitlab/connections/${connectionId}` })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).toContain('1 managed project')
    expect(await prisma.gitlabConnection.count({ where: { id: connectionId } })).toBe(1)
  })

  it('searches accessible projects through the connection', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const res = await a.app.inject({
      method: 'GET',
      url: `${ORG}/gitlab/connections/${connectionId}/projects?search=example`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      projects: [
        {
          projectId: '4455667',
          path: 'example-group/example-project',
          defaultBranch: 'main',
          lastActivityAt: '2026-08-20T00:00:00.000Z'
        }
      ],
      nextPage: null
    })
  })

  it('binds a project: re-fetch, Maintainer gate, claim, provisioning state', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const res = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      projectId: '4455667',
      projectPath: 'example-group/example-project',
      state: 'ready',
      // No agent consumes this project yet, so it has no member accounts (§7.2).
      accounts: [],
      // No enabled trigger points at it either, so no ingress is wanted — a normal resting state.
      webhookState: 'not_needed'
    })
    // The claim and the provider-qualified catalog row were acquired atomically.
    const claim = await prisma.codeHostRepositoryClaim.findUniqueOrThrow({
      where: { provider_externalId: { provider: 'gitlab', externalId: 4455667n } }
    })
    expect(claim.orgId).toBe(DEFAULT_ORG_ID)
    expect(claim.bindingRef).toBeTruthy()
    await prisma.codeHostRepository.findUniqueOrThrow({
      where: {
        orgId_provider_externalId: { orgId: DEFAULT_ORG_ID, provider: 'gitlab', externalId: 4455667n }
      }
    })
    // Same org, same project again: the binding uniqueness answers first.
    const dup = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    expect(dup.statusCode).toBe(409)
    const list = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/projects` })
    expect((list.json() as { bindings: unknown[] }).bindings).toHaveLength(1)
  })

  // The project list is the console's only GitLab identity read (§18.1): the agent page reads the
  // bot it acts as off this member row, so the row carries its name, health, and profile id.
  it('names each consuming agent’s bot on the project it is bound to (§7.2)', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n })
    const bound = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    expect(bound.statusCode).toBe(200)

    const list = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/projects` })
    const { bindings } = list.json() as { bindings: Array<{ accounts: Array<Record<string, unknown>> }> }
    expect(bindings[0]!.accounts).toHaveLength(1)
    expect(bindings[0]!.accounts[0]).toMatchObject({
      agentId,
      username: gitlabAgentAccountUsername(agentId, 'reviewer', 900n),
      displayName: 'reviewer',
      state: 'ready',
      stateReason: null
    })
    // The account exists on GitLab, so the console may link its profile — and never a token.
    expect(bindings[0]!.accounts[0]!.userId).toMatch(/^\d+$/)
    expect(JSON.stringify(bindings)).not.toContain('glpat')
  })

  it('refuses managed installation below Maintainer (§10.1)', async () => {
    const a = gitlabApp({ accessLevel: 30 })
    const { connectionId } = await connect(a)
    const res = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    expect(res.statusCode).toBe(403)
    expect(await prisma.gitlabProjectBinding.count()).toBe(0)
    expect(await prisma.codeHostRepositoryClaim.count()).toBe(0)
  })

  it('refuses a project already claimed by another organization, without naming it', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    await prisma.codeHostRepositoryClaim.create({
      data: { provider: 'gitlab', externalId: 4455667n, orgId: 'some-other-org', state: 'active' }
    })
    const res = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId: '4455667' }
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { message: string }).message).not.toContain('some-other-org')
    expect(await prisma.gitlabProjectBinding.count()).toBe(0)
  })

  it('404s the whole surface when the deployment has no gitlab oauth app', async () => {
    running = buildHttpApp(prisma, { PUBLIC_CP_URL: PUBLIC_CP })
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/gitlab/connections` })
    expect(res.statusCode).toBe(404)
  })
})
/**
 * The Integrations card's bot roster (§18.1): every account the organization owns,
 * with the agent it acts for and the projects it is a member of, in one read.
 */
describe('gitlab organization bot roster (§7.2, §18.1)', () => {
  const rosterUrl = (org = ORG) => `${org}/gitlab/accounts`

  type RosterAccount = Record<string, unknown> & {
    bindingIds: string[]
  }

  async function rosterRead(a: HttpApp): Promise<{ accounts: RosterAccount[]; converging: boolean }> {
    const res = await a.app.inject({ method: 'GET', url: rosterUrl() })
    expect(res.statusCode).toBe(200)
    return res.json() as { accounts: RosterAccount[]; converging: boolean }
  }

  async function roster(a: HttpApp): Promise<RosterAccount[]> {
    return (await rosterRead(a)).accounts
  }

  async function bind(a: HttpApp, connectionId: string, projectId: string): Promise<string> {
    const bound = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitlab/projects`,
      payload: { connectionId, projectId }
    })
    expect(bound.statusCode).toBe(200)
    return (bound.json() as { id: string }).id
  }

  it('reports each bot with its agent, group, health, and the project it is a member of', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n, gitAccess: 'write' })
    const bindingId = await bind(a, connectionId, '4455667')

    const accounts = await roster(a)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      agentId,
      rootGroupId: '900',
      rootGroupPath: 'example-group',
      username: gitlabAgentAccountUsername(agentId, 'reviewer', 900n),
      displayName: 'reviewer',
      state: 'ready',
      stateReason: null,
      lifecycle: 'active'
    })
    // The membership carries the role GitLab enforces, so the card can name it.
    expect(accounts[0]!.bindingIds).toEqual([bindingId])
    expect(accounts[0]!.userId).toMatch(/^\d+$/)
    expect(JSON.stringify(accounts)).not.toContain('glpat')
  })

  it('gives a project consumed by two agents one bot each, with the role each derives', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const writer = randomUUID()
    const reader = randomUUID()
    await seedAgent(prisma, writer, { name: 'reviewer', gitlabProjectId: 4455667n, gitAccess: 'write' })
    await seedAgent(prisma, reader, { name: 'triager', gitlabProjectId: 4455667n, gitAccess: 'read' })
    const bindingId = await bind(a, connectionId, '4455667')

    const accounts = await roster(a)
    expect(accounts).toHaveLength(2)
    // One account per AGENT, not per project: the binding appears under both.
    expect(accounts.every((account) => account.bindingIds[0] === bindingId)).toBe(true)
    expect(new Set(accounts.map((account) => account.agentId))).toEqual(new Set([writer, reader]))
  })

  it('omits a bot whose agent the caller cannot see, and keeps the visible one', async () => {
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const visible = randomUUID()
    const hidden = randomUUID()
    await seedAgent(prisma, visible, { name: 'reviewer', gitlabProjectId: 4455667n })
    await seedAgent(prisma, hidden, {
      name: 'private-reviewer',
      gitlabProjectId: 4455667n,
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })
    await bind(a, connectionId, '4455667')
    // The owner sees both bots on the project.
    expect(await roster(a)).toHaveLength(2)
    await a.close()

    const users = new PgUserRepo(prisma)
    const email = `outsider-${randomUUID().slice(0, 8)}@example.test`
    const { userId: outsider } = await users.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
    const asOutsider = gitlabApp({}, outsider)

    const seen = await roster(asOutsider)
    expect(seen.map((account) => account.agentId)).toEqual([visible])
    // The restricted agent's bot is absent, not redacted — nothing names it.
    expect(JSON.stringify(seen)).not.toContain('private-reviewer')
  })

  it('is empty for an organization with no bot accounts, and another organization reads as absent', async () => {
    const a = gitlabApp()
    await connect(a)
    expect(await roster(a)).toEqual([])

    // Cross-org is 404 at the tenancy boundary, never someone else's roster.
    const foreign = await a.app.inject({ method: 'GET', url: rosterUrl(`/api/v1/orgs/${randomUUID()}`) })
    expect(foreign.statusCode).toBe(404)
  })

  it('404s with the rest of the surface when the deployment has no gitlab oauth app', async () => {
    running = buildHttpApp(prisma, { PUBLIC_CP_URL: PUBLIC_CP })
    expect((await running.app.inject({ method: 'GET', url: rosterUrl() })).statusCode).toBe(404)
  })

  it('reports a wanted webhook as installed, and an unwanted one as not needed', async () => {
    // The two are the same absence of trouble, but only one of them is an absence of a webhook —
    // reporting a project with no trigger as lacking one turns a resting state into an alarm.
    const a = gitlabApp()
    const { connectionId } = await connect(a)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n })
    await bind(a, connectionId, '4455667')

    const listed = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/projects` })
    expect((listed.json() as { bindings: Array<{ webhookState: string }> }).bindings[0]!.webhookState).toBe(
      'not_needed'
    )

    // An enabled trigger on the project is what wants ingress; repair installs it.
    await prisma.hookDef.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId,
        kind: 'gitlab',
        name: 'reviews',
        sessionMode: 'perDelivery',
        repoId: 4455667n
      }
    })
    const bindingId = (
      (await (await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/projects` })).json()) as {
        bindings: Array<{ id: string }>
      }
    ).bindings[0]!.id
    const repaired = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/repair` })
    expect(repaired.statusCode).toBe(200)
    expect((repaired.json() as { webhookState: string }).webhookState).toBe('installed')
  })

  /**
   * Enabling a trigger commits before the convergence it fires, so the window between the two
   * must not look like a broken webhook — and the console has to be told to wait it out.
   */
  describe('webhook state', () => {
    async function hookOn(agentId: string): Promise<string> {
      const hookId = randomUUID()
      await prisma.hookDef.create({
        data: {
          id: hookId,
          orgId: DEFAULT_ORG_ID,
          agentId,
          kind: 'gitlab',
          name: 'reviews',
          sessionMode: 'perDelivery',
          repoId: 4455667n
        }
      })
      return hookId
    }

    async function onlyBinding(a: HttpApp): Promise<{ id: string; webhookState: string }> {
      const res = await a.app.inject({ method: 'GET', url: `${ORG}/gitlab/projects` })
      return (res.json() as { bindings: Array<{ id: string; webhookState: string }> }).bindings[0]!
    }

    it('calls a webhook wanted but not yet installed transient, and keeps the roster asking', async () => {
      const a = gitlabApp()
      const { connectionId } = await connect(a)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n })
      await bind(a, connectionId, '4455667')
      expect((await onlyBinding(a)).webhookState).toBe('not_needed')

      // The hook write lands; its convergence has not run yet. That is not a failure.
      await hookOn(agentId)
      expect((await onlyBinding(a)).webhookState).toBe('repairing')
      // And the console is told to keep asking, so the badge cannot get stuck.
      expect((await rosterRead(a)).converging).toBe(true)
    })

    it('clears once the install completes, and stops asking', async () => {
      const a = gitlabApp()
      const { connectionId } = await connect(a)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n })
      await bind(a, connectionId, '4455667')
      await hookOn(agentId)

      const { id } = await onlyBinding(a)
      expect((await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${id}/repair` })).statusCode).toBe(200)
      expect((await onlyBinding(a)).webhookState).toBe('installed')
      expect((await rosterRead(a)).converging).toBe(false)
    })

    it('reports failed only once a run actually tried and could not, and then rests', async () => {
      // No public webhook address configured: the webhook step runs and refuses (§10.2).
      const a = gitlabApp({}, undefined, { publicRelayUrl: '' })
      const { connectionId } = await connect(a)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n })
      await bind(a, connectionId, '4455667')
      await hookOn(agentId)

      const { id } = await onlyBinding(a)
      await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${id}/repair` })
      const settled = await onlyBinding(a)
      expect(settled.webhookState).toBe('failed')
      // Settled: a failure waits for a person, so the console stops polling on it.
      expect((await rosterRead(a)).converging).toBe(false)
    })
  })

  /**
   * The console cannot see an agent's hooks or workspace, so it cannot tell a converged
   * roster from one read mid-flight. `converging` is that answer, and it has to terminate.
   */
  describe('convergence signal', () => {
    it('is settled once every consumer holds the membership it wants', async () => {
      const a = gitlabApp()
      const { connectionId } = await connect(a)
      await seedAgent(prisma, randomUUID(), { name: 'reviewer', gitlabProjectId: 4455667n })
      await bind(a, connectionId, '4455667')

      expect((await rosterRead(a)).converging).toBe(false)
    })

    it('is unsettled while a consumer added after the project still owes a membership', async () => {
      // Exactly the shape a hook created on another page has before its saga runs: the
      // project set is unchanged, so nothing about the roster's key would move.
      const a = gitlabApp()
      const { connectionId } = await connect(a)
      await bind(a, connectionId, '4455667')
      expect((await rosterRead(a)).converging).toBe(false)

      await seedAgent(prisma, randomUUID(), { name: 'late-arrival', gitlabProjectId: 4455667n })
      expect((await rosterRead(a)).converging).toBe(true)
    })

    it('is unsettled while a membership no consumer justifies still awaits detach', async () => {
      const a = gitlabApp()
      const { connectionId } = await connect(a)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n })
      await bind(a, connectionId, '4455667')
      expect((await rosterRead(a)).converging).toBe(false)

      // The consumer goes away; its membership is removed asynchronously.
      await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: null } })
      expect((await rosterRead(a)).converging).toBe(true)
    })

    it('is unsettled while a surviving membership still holds the role a dropped hook raised it to', async () => {
      // A read-only workspace earns Reporter; an enabled hook raises the same agent to Developer.
      // Dropping the hook does not remove the membership, it downgrades it — a change no set of
      // agent ids can see, and the one the card would otherwise show as Developer forever.
      const a = gitlabApp()
      const { connectionId } = await connect(a)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n, gitAccess: 'read' })
      const hookId = randomUUID()
      await prisma.hookDef.create({
        data: {
          id: hookId,
          orgId: DEFAULT_ORG_ID,
          agentId,
          kind: 'gitlab',
          name: 'reviews',
          sessionMode: 'perDelivery',
          repoId: 4455667n
        }
      })
      const bindingId = await bind(a, connectionId, '4455667')

      const raised = await rosterRead(a)
      expect(raised.accounts[0]!.bindingIds).toEqual([bindingId])
      expect(raised.converging).toBe(false)

      // The hook goes; the membership survives at the role only the hook justified.
      await prisma.hookDef.delete({ where: { id: hookId } })
      const pending = await rosterRead(a)
      expect(pending.accounts[0]!.bindingIds).toEqual([bindingId])
      expect(pending.converging).toBe(true)

      // Convergence writes the workspace's own role, and the answer settles on it.
      const repaired = await a.app.inject({ method: 'POST', url: `${ORG}/gitlab/projects/${bindingId}/repair` })
      expect(repaired.statusCode).toBe(200)
      const settled = await rosterRead(a)
      expect(settled.accounts[0]!.bindingIds).toEqual([bindingId])
      expect(settled.converging).toBe(false)
    })

    it('is unsettled by a membership whose consumer went away, even on a degraded account', async () => {
      // The refusal exemption exists for a membership that cannot be CREATED without repair. A
      // membership already recorded and no longer justified is a detach the saga owes regardless,
      // and exempting it left the project sitting under that bot for good.
      const a = gitlabApp()
      const { connectionId } = await connect(a)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { name: 'reviewer', gitlabProjectId: 4455667n })
      await bind(a, connectionId, '4455667')
      expect((await rosterRead(a)).converging).toBe(false)

      // Rotation trouble degrades the account while it keeps its membership.
      await prisma.gitlabAgentAccount.updateMany({
        where: { orgId: DEFAULT_ORG_ID, agentId },
        data: { state: 'admin_degraded', stateReason: 'rotation_gitlab_503' }
      })
      expect((await rosterRead(a)).converging).toBe(false)

      // Now its last consumer goes; the detach is still owed and must be reported.
      await prisma.agent.update({ where: { id: agentId }, data: { workspaceRepoId: null } })
      expect((await rosterRead(a)).converging).toBe(true)
    })

    it('settles on a refused account rather than asking forever about one that needs Repair', async () => {
      // The group hit its bot ceiling: the account row exists, no membership can attach, and
      // nothing will change until a human acts. Reporting that as convergence would never end.
      const a = gitlabApp({ refuseServiceAccountQuota: true })
      const { connectionId } = await connect(a)
      await seedAgent(prisma, randomUUID(), { name: 'reviewer', gitlabProjectId: 4455667n })
      await bind(a, connectionId, '4455667')

      const read = await rosterRead(a)
      expect(read.accounts[0]).toMatchObject({ state: 'admin_degraded', stateReason: 'service_account_quota' })
      expect(read.accounts[0]!.bindingIds).toEqual([])
      expect(read.converging).toBe(false)
    })
  })
})
