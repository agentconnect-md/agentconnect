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

function gitlabApp(options: FakeGitlabOptions = {}, callerUserId?: string): HttpApp & { fake: FakeGitlab } {
  const fake = new FakeGitlab(options)
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1' },
    connections: new PgGitlabConnectionRepo(prisma),
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    cipher,
    clock: systemClock,
    publicCpUrl: PUBLIC_CP,
    webAppUrl: 'https://console.example.test',
    fetchImpl: fake.fetch()
  })
  const accountService = new GitlabAccountService({
    oauth,
    accounts: new PgGitlabAgentAccountRepo(prisma),
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    agents: new PgAgentRepo(prisma),
    cipher,
    clock: systemClock,
    fetchImpl: fake.fetch()
  })
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings: new PgGitlabProjectBindingRepo(prisma),
    accounts: accountService,
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    clock: systemClock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => null,
    fetchImpl: fake.fetch()
  })
  running = buildHttpApp(
    prisma,
    { PUBLIC_CP_URL: PUBLIC_CP, ...(callerUserId ? { DEFAULT_OWNER_ID: callerUserId } : {}) },
    undefined,
    undefined,
    { gitlab: { oauth, provisioner, accounts: accountService, fetchImpl: fake.fetch() } }
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
    sealedPair: { accessToken: 'at-taker', refreshToken: 'rt-taker' }
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
      webhookInstalled: false
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
