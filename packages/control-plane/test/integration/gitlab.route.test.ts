/**
 * GitLab OAuth connection routes (gitlab-com-integration.md §9, §18.2):
 * start → begin → callback over real Pg stores with a stubbed gitlab.com edge,
 * metadata-only DTOs, single-use state, browser binding, and disconnect.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { GitlabOauthService } from '../../src/gitlab/oauth.service.js'
import {
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

function gitlabApp(options: FakeGitlabOptions = {}): HttpApp {
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
  const provisioner = new GitlabProvisioner({
    oauth,
    bindings: new PgGitlabProjectBindingRepo(prisma),
    credentials: new PgGitlabProjectCredentialRepo(prisma),
    credentialSecrets: new PgGitlabProjectCredentialSecretStore(prisma, cipher),
    webhookSecrets: new PgGitlabWebhookSecretStore(prisma, cipher),
    catalog: new PgCodeHostRepositoryRepo(prisma),
    cipher,
    clock: systemClock,
    publicRelayUrl: 'https://relay.example.test',
    desiredWebhookEvents: async () => null,
    fetchImpl: fake.fetch()
  })
  running = buildHttpApp(prisma, { PUBLIC_CP_URL: PUBLIC_CP }, undefined, undefined, {
    gitlab: { oauth, provisioner, fetchImpl: fake.fetch() }
  })
  return running
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
      scopes: ['api']
    })
    // Metadata only: no token-shaped field leaves the DTO.
    expect(JSON.stringify(body)).not.toContain('at-1')
    expect(JSON.stringify(body)).not.toContain('rt-1')
    // The pair itself landed sealed in the side-table.
    const secret = await prisma.gitlabConnectionSecret.findUniqueOrThrow({ where: { connectionId } })
    expect(secret.accessToken).toBeTruthy()
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
    expect((res.json() as { state: string }).state).toBe('disconnected')
    expect(await prisma.gitlabConnectionSecret.findUnique({ where: { connectionId } })).toBeNull()
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
      serviceAccountUsername: 'agentconnect-p4455667',
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
