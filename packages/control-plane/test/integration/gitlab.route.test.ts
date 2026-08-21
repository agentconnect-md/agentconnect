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
import type { FetchLike } from '../../src/gitlab/api.js'
import {
  PgGitlabConnectionRepo,
  PgGitlabConnectionSecretStore,
  PgGitlabOauthStateStore
} from '../../src/persistence/repositories/gitlab.repo.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { systemClock } from '../../src/domain/clock.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PUBLIC_CP = 'https://api.example.test'

const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)

function gitlabFetch(): FetchLike {
  return async (url) => {
    if (url.endsWith('/oauth/token')) {
      return Response.json({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 7200,
        created_at: Math.floor(Date.now() / 1000),
        scope: 'api'
      })
    }
    if (url.endsWith('/user')) return Response.json({ id: 4242, username: 'example-admin' })
    if (url.endsWith('/oauth/revoke')) return Response.json({})
    throw new Error(`unexpected gitlab call: ${url}`)
  }
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

function gitlabApp(): HttpApp {
  const oauth = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1' },
    connections: new PgGitlabConnectionRepo(prisma),
    secrets: new PgGitlabConnectionSecretStore(prisma, cipher),
    states: new PgGitlabOauthStateStore(prisma),
    cipher,
    clock: systemClock,
    publicCpUrl: PUBLIC_CP,
    webAppUrl: 'https://console.example.test',
    isOrgMember: async (orgId, userId) => (await prisma.membership.count({ where: { orgId, userId } })) > 0,
    fetchImpl: gitlabFetch()
  })
  running = buildHttpApp(prisma, { PUBLIC_CP_URL: PUBLIC_CP }, undefined, undefined, {
    gitlab: { oauth }
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

  it('404s the whole surface when the deployment has no gitlab oauth app', async () => {
    running = buildHttpApp(prisma, { PUBLIC_CP_URL: PUBLIC_CP })
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/gitlab/connections` })
    expect(res.statusCode).toBe(404)
  })
})
