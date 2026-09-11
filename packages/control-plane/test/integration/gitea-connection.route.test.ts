/**
 * The Gitea connection routes (gitea-integration.md §4, §12) over real Postgres and the stateful
 * fake edge: the four connect checks, the write-only token, replacement with the same bot and its
 * epoch bump, and a disconnect that walks the bindings' removal path first.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { buildGiteaSeam, type GiteaSeam, type GiteaSeamOptions } from '../fakes/gitea-seam.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REPO = 556677n
const TOKEN = 'gitea-token-1'
// Real-time clock whose pending timers die with the test — see fakes/tracked-clock.ts.
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

let running: HttpApp | undefined
let seam: GiteaSeam | undefined
afterEach(async () => {
  await seam?.settled()
  await running?.close()
  running = undefined
  seam = undefined
})

function app(options: GiteaSeamOptions = {}): HttpApp & { seam: GiteaSeam } {
  const built = buildGiteaSeam(prisma, cipher, clock, options)
  seam = built
  running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: 'https://relay.example.test' }, undefined, undefined, {
    gitea: { connections: built.connections, provisioner: built.provisioner, api: built.api }
  })
  built.broadcast.current = (hook) => running!.deps.hooks.broadcast(hook)
  return { ...running, seam: built }
}

async function connect(a: HttpApp, token = TOKEN): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitea/connections`, payload: { token } })
  expect(res.statusCode).toBe(200)
  const body = res.json() as Record<string, unknown>
  return { id: body.id as string, body }
}

async function bind(a: HttpApp, repoId = REPO): Promise<{ id: string; state: string; stateReason: string | null }> {
  const res = await a.app.inject({
    method: 'POST',
    url: `${ORG}/gitea/repositories`,
    payload: { repoId: repoId.toString() }
  })
  expect(res.statusCode).toBe(200)
  return res.json() as { id: string; state: string; stateReason: string | null }
}

describe('POST /gitea/connections (§4.1)', () => {
  it('verifies the token, seals it, and never echoes it', async () => {
    const a = app()
    const { body } = await connect(a)
    expect(body).toMatchObject({
      botUserId: '9042',
      botUsername: 'example-bot',
      botDisplayName: 'Example Bot',
      state: 'connected',
      credentialEpoch: '1',
      boundRepositories: 0,
      instanceUrl: 'https://gitea.com',
      instanceVersion: '1.27.3',
      instanceVersionSupported: true,
      instanceVersionFloor: '1.23',
      requiredScopes: ['read:user', 'write:repository', 'write:issue', 'read:organization']
    })
    expect(JSON.stringify(body)).not.toContain(TOKEN)
    // The checks ran with the token: the user read, the floor, the two read probes, and the two write probes against a repository that does not exist.
    const urls = a.seam.fake.requests.map((r) => `${r.method} ${r.url.replace('https://gitea.com/api/v1', '')}`)
    expect(urls.slice(0, 4)).toEqual([
      'GET /user',
      'GET /version',
      'GET /user/repos?page=1&limit=1',
      'GET /user/orgs?page=1&limit=1'
    ])
    expect(urls[4]).toMatch(/^POST \/repos\/example-bot\/agentconnect-scope-probe-[0-9a-f]{12}\/hooks$/)
    expect(urls[5]).toMatch(/^POST \/repos\/example-bot\/agentconnect-scope-probe-[0-9a-f]{12}\/issues\/1\/reactions$/)
    expect(urls).toHaveLength(6)
    expect(a.seam.fake.hooks.size).toBe(0)
    expect(a.seam.fake.requests.filter((r) => r.url.endsWith('/user')).every((r) => r.token === TOKEN)).toBe(true)
    // Sealed beside the row (the test cipher is the identity), never on the row itself.
    const row = await prisma.giteaConnection.findFirstOrThrow({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row.botUserId).toBe(9042n)
    const secret = await prisma.giteaConnectionSecret.findUniqueOrThrow({ where: { connectionId: row.id } })
    expect(secret.token).toBe(TOKEN)
    const listed = await a.app.inject({ method: 'GET', url: `${ORG}/gitea/connections` })
    expect((listed.json() as { connections: unknown[] }).connections).toHaveLength(1)
  })

  it('refuses a rejected token and a token missing a required scope, storing nothing', async () => {
    const a = app({ fake: { scopes: { user: 'read', repository: 'write', issue: 'write' } } })
    const rejected = await a.app.inject({ method: 'POST', url: `${ORG}/gitea/connections`, payload: { token: 'nope' } })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ code: 'token_rejected' })
    // The organization scope is required, not optional: the picker's organization listing needs it (§4.1).
    const scoped = await a.app.inject({ method: 'POST', url: `${ORG}/gitea/connections`, payload: { token: TOKEN } })
    expect(scoped.statusCode).toBe(400)
    expect(scoped.json()).toMatchObject({
      code: 'missing_scope',
      message: expect.stringContaining('read:organization')
    })
    expect(await prisma.giteaConnection.count()).toBe(0)
  })

  it('refuses a token that can read everything but write nothing, naming the write scope it lacks', async () => {
    // Every read probe passes; only a write-method request tells a read-only token apart (§4.1).
    const readOnly = app({
      fake: { scopes: { user: 'read', repository: 'read', organization: 'read', issue: 'read' } }
    })
    const res = await readOnly.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/connections`,
      payload: { token: TOKEN }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'missing_scope', message: expect.stringContaining('write:repository') })
    expect(await prisma.giteaConnection.count()).toBe(0)
    await readOnly.close()
    // A token that can administer repositories but not comment is refused for the reply it could never post.
    const noIssue = app({
      fake: { scopes: { user: 'read', repository: 'write', organization: 'read', issue: 'read' } }
    })
    const issue = await noIssue.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/connections`,
      payload: { token: TOKEN }
    })
    expect(issue.statusCode).toBe(400)
    expect(issue.json()).toMatchObject({ code: 'missing_scope', message: expect.stringContaining('write:issue') })
    // Replacing a working connection with such a token is refused the same way.
    await noIssue.close()
    const a = app()
    const { id } = await connect(a)
    a.seam.fake.opts.scopes = { user: 'read', repository: 'read', organization: 'read', issue: 'read' }
    const replaced = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/connections/${id}/token`,
      payload: { token: TOKEN }
    })
    expect(replaced.statusCode).toBe(400)
    expect(replaced.json()).toMatchObject({ code: 'missing_scope' })
    expect((await prisma.giteaConnection.findUniqueOrThrow({ where: { id } })).credentialEpoch).toBe(1n)
  })

  it('refuses an instance below the 1.23 floor, a fork included', async () => {
    const a = app({ fake: { version: '11.0.0+gitea-1.22.0' } })
    const res = await a.app.inject({ method: 'POST', url: `${ORG}/gitea/connections`, payload: { token: TOKEN } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'instance_version_unsupported' })
    expect(await prisma.giteaConnection.count()).toBe(0)
  })

  it('refuses a bot already serving another organization, and a second connection in this one', async () => {
    const a = app()
    await connect(a)
    const second = await a.app.inject({ method: 'POST', url: `${ORG}/gitea/connections`, payload: { token: TOKEN } })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'connection_exists' })
    // Another organization pasting the same bot's token: the uniqueness is deployment-global (§4.1).
    const foreign = await prisma.org.create({ data: { name: 'Foreign', slug: 'foreign-gitea' } })
    await expect(a.seam.connections.connect(foreign.id, TOKEN)).rejects.toMatchObject({
      status: 409,
      code: 'bot_already_bound'
    })
    expect(await prisma.giteaConnection.count()).toBe(1)
  })
})

describe('POST /gitea/connections/:id/token (§4.3)', () => {
  it('switches the sealed token for the same bot and advances the credential epoch', async () => {
    const a = app()
    const { id } = await connect(a)
    a.seam.fake.token = 'gitea-token-2'
    const res = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/connections/${id}/token`,
      payload: { token: 'gitea-token-2' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id, credentialEpoch: '2', state: 'connected' })
    expect(JSON.stringify(res.json())).not.toContain('gitea-token')
    const secret = await prisma.giteaConnectionSecret.findUniqueOrThrow({ where: { connectionId: id } })
    expect(secret.token).toBe('gitea-token-2')
  })

  it('refuses a replacement that belongs to a different bot user', async () => {
    const a = app()
    const { id } = await connect(a)
    a.seam.fake.opts.bot = { id: 7777, login: 'other-bot' }
    const res = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/connections/${id}/token`,
      payload: { token: TOKEN }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'bot_user_mismatch' })
    const row = await prisma.giteaConnection.findUniqueOrThrow({ where: { id } })
    expect(row.credentialEpoch).toBe(1n)
  })

  it('heals bindings the rejected token degraded once the replacement lands', async () => {
    const a = app()
    const { id } = await connect(a)
    const binding = await bind(a)
    expect(binding.state).toBe('ready')
    // The token is revoked at the instance: the next repair rejects, flipping connection and binding.
    a.seam.fake.token = 'revoked'
    const repaired = await a.app.inject({ method: 'POST', url: `${ORG}/gitea/repositories/${binding.id}/repair` })
    expect(repaired.json()).toMatchObject({ state: 'runtime_degraded', stateReason: 'token_rejected' })
    expect((await prisma.giteaConnection.findUniqueOrThrow({ where: { id } })).state).toBe('token_rejected')
    // A repair while rejected touches nothing at the provider.
    a.seam.fake.requests.length = 0
    await a.app.inject({ method: 'POST', url: `${ORG}/gitea/repositories/${binding.id}/repair` })
    expect(a.seam.fake.requests).toHaveLength(0)

    a.seam.fake.token = 'gitea-token-2'
    const res = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/connections/${id}/token`,
      payload: { token: 'gitea-token-2' }
    })
    expect(res.statusCode).toBe(200)
    await a.seam.settled()
    const healed = await prisma.giteaRepositoryBinding.findUniqueOrThrow({ where: { id: binding.id } })
    expect(healed).toMatchObject({ state: 'ready', stateReason: null })
    expect((await prisma.giteaConnection.findUniqueOrThrow({ where: { id } })).state).toBe('connected')
  })
})

describe('DELETE /gitea/connections/:id (§6)', () => {
  it('removes the connection once every binding has been cleaned up', async () => {
    const a = app()
    const { id } = await connect(a)
    await bind(a)
    const res = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitea/connections/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ removed: true, pendingRepositories: 0, connection: null })
    expect(await prisma.giteaConnection.count()).toBe(0)
    expect(await prisma.giteaConnectionSecret.count()).toBe(0)
    expect(await prisma.giteaRepositoryBinding.count()).toBe(0)
    // The deployment-global claim released with the verified cleanup.
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea' } })).toBe(0)
    // The same bot may now connect again, elsewhere or here.
    await connect(a)
  })

  it('parks the bindings and keeps the row while a rejected token owes their cleanup', async () => {
    const a = app()
    const { id } = await connect(a)
    const binding = await bind(a)
    a.seam.fake.token = 'revoked'
    const res = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitea/connections/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      removed: false,
      pendingRepositories: 1,
      connection: { id, state: 'disconnecting' }
    })
    const parked = await prisma.giteaRepositoryBinding.findUniqueOrThrow({ where: { id: binding.id } })
    expect(parked).toMatchObject({ state: 'cleanup_pending', stateReason: 'token_rejected' })
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea' } })).toBe(1)
    // A replacement token clears the parked cleanup; the row then goes on the next delete.
    a.seam.fake.token = 'gitea-token-2'
    const replaced = await a.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/connections/${id}/token`,
      payload: { token: 'gitea-token-2' }
    })
    expect(replaced.statusCode).toBe(200)
    await a.seam.settled()
    expect(await prisma.giteaRepositoryBinding.count()).toBe(0)
    const again = await a.app.inject({ method: 'DELETE', url: `${ORG}/gitea/connections/${id}` })
    expect(again.json()).toMatchObject({ removed: true })
  })
})

describe('GET /gitea/connections/:id/repositories (§6 picker)', () => {
  it('lists the repositories the bot administers, keyed by numeric id, across its organizations', async () => {
    const a = app({
      fake: {
        repositories: [
          { id: 556677, full_name: 'example-org/example-repo', admin: true },
          { id: 556678, full_name: 'example-org/read-only', admin: false },
          { id: 556679, full_name: 'example-bot/personal', admin: true, private: true }
        ],
        maxResponseItems: 1
      }
    })
    const { id } = await connect(a)
    a.seam.fake.requests.length = 0
    const res = await a.app.inject({ method: 'GET', url: `${ORG}/gitea/connections/${id}/repositories` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      repositories: [
        {
          repoId: '556679',
          path: 'example-bot/personal',
          cloneUrl: 'https://gitea.com/example-bot/personal.git',
          defaultBranch: 'main',
          private: true
        },
        {
          repoId: '556677',
          path: 'example-org/example-repo',
          cloneUrl: 'https://gitea.com/example-org/example-repo.git',
          defaultBranch: 'main',
          private: false
        }
      ]
    })
    // Paged at the instance ceiling, following Link: the organization listing took two pages.
    const orgPages = a.seam.fake.requests.filter((r) => r.url.includes('/orgs/example-org/repos'))
    expect(orgPages.map((r) => new URL(r.url).searchParams.get('page'))).toEqual(['1', '2'])
  })
})
