import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogtoIdentityService } from '../src/github/logto-identity.js'
import { GithubRepoIdentityService } from '../src/github/repo-identity.js'
import { GithubUserAuthzService } from '../src/github/user-authz.js'
import type { HttpDeps } from '../src/http/deps.js'
import { installZod } from '../src/http/plugins/zod.js'
import { meSocialIdentityRoutes } from '../src/http/routes/me-social-identities.js'
import { PgGithubRepoIdentityStore, PgSocialIdentityMutationGate } from '../src/persistence/index.js'
import type { GithubInstallationRecord } from '../src/persistence/ports.js'
import { PlaintextSecretCipher } from '../src/secrets/cipher.js'
import { FakeClock } from './fakes/fake-clock.js'
import { prisma } from './setup.db.js'

const MGMT = {
  endpoint: 'https://login.example.test',
  appId: 'app',
  appSecret: 'secret',
  resource: 'https://login.example.test/api'
}
const OAUTH = {
  clientId: 'Iv1.example',
  clientSecret: 'client-secret',
  redirectUri: 'https://console.example.test/auth/social/callback'
}
const installation = { installationId: 42n } as GithubInstallationRecord
const users = new Map<string, Record<string, object>>()
const clock = new FakeClock()
const store = new PgGithubRepoIdentityStore(prisma)
const github = { userById: vi.fn(async () => ({ id: 123n, login: 'octocat' })) }
const calls: Array<{ url: string; init?: RequestInit }> = []
let beforeExchange: (() => Promise<void>) | undefined
let providerStatus = 200
let malformedUser = false
const apps: Array<ReturnType<typeof Fastify>> = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fetchLogto(url: string, init?: RequestInit): Promise<Response> {
  if (url.endsWith('/oidc/token')) return Response.json({ access_token: 'm2m-token', expires_in: 3600 })
  const parts = new URL(url).pathname.split('/')
  const sub = decodeURIComponent(parts[3]!)
  if (init?.method === 'DELETE') {
    delete users.get(sub)?.[parts[5]!]
    return new Response(null, { status: 204 })
  }
  const identities = users.get(sub)
  return identities && providerStatus === 200
    ? Response.json({ identities })
    : new Response(null, { status: identities ? providerStatus : 404 })
}

async function fetchGithub(url: string, init?: RequestInit): Promise<Response> {
  calls.push({ url, init })
  if (url.endsWith('/login/oauth/access_token')) {
    await beforeExchange?.()
    return Response.json({ access_token: 'temporary-user-token' })
  }
  if (url.endsWith('/user')) return Response.json(malformedUser ? { id: 'invalid' } : { id: 123, login: 'octocat' })
  if (url.endsWith('/token') && init?.method === 'DELETE') return new Response(null, { status: 204 })
  throw new Error('unexpected GitHub request')
}

function instance(oauth: typeof OAUTH | null = OAUTH) {
  const mutations = new PgSocialIdentityMutationGate(prisma)
  const repo = new GithubRepoIdentityService({
    store,
    mutations,
    clock,
    github,
    cipher: new PlaintextSecretCipher(),
    assertLinkable: (sub) => identity.assertGithubRepoLinkable(sub),
    invalidate: (sub) => identity.forgetGithubLogin(sub),
    ...(oauth ? { oauth } : {}),
    fetchImpl: fetchGithub
  })
  const identity: LogtoIdentityService = new LogtoIdentityService(MGMT, clock, mutations, fetchLogto, undefined, {
    githubRepoIdentity: repo
  })
  return { repo, identity }
}

async function http(service: ReturnType<typeof instance>, userId = 'second') {
  const app = Fastify()
  apps.push(app)
  installZod(app)
  app.decorate('oidcAuth', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer console-session') return reply.code(401).send()
    req.oidcSubject = userId
    req.principal = { userId } as NonNullable<typeof req.principal>
  })
  await app.register(
    meSocialIdentityRoutes({
      logtoIdentity: service.identity,
      githubRepoIdentity: service.repo,
      config: { PUBLIC_WEB_URL: 'https://console.example.test' }
    } as unknown as HttpDeps)
  )
  return app
}

beforeEach(async () => {
  users.clear()
  users.set('first', { github: { userId: '123', details: { rawData: { login: 'octocat' } } } })
  users.set('second', { google: { userId: 'google-second' } })
  users.set('third', { google: { userId: 'google-third' } })
  await prisma.user.createMany({
    data: [...users.keys()].map((id) => ({ id, oidcSubject: id, email: `${id}@example.test` }))
  })
  calls.length = 0
  beforeExchange = undefined
  providerStatus = 200
  malformedUser = false
  github.userById.mockClear().mockResolvedValue({ id: 123n, login: 'octocat' })
})

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

describe('repository-only GitHub identity', () => {
  it('preserves existing identities with OAuth disabled and still permits disconnecting a saved connection', async () => {
    const { repo, identity } = instance(null)
    expect(repo.enabled).toBe(false)
    await expect(repo.authorize('second', 'second')).rejects.toMatchObject({ status: 503 })
    expect(await identity.githubLoginFor('first', undefined, installation)).toBe('octocat')
    await prisma.githubRepoIdentity.create({ data: { userId: 'second', githubUserId: 123n, login: 'octocat' } })
    expect(await identity.githubLoginFor('second', undefined, installation)).toBe('octocat')
    await repo.disconnect('second')
    expect(await identity.githubLoginFor('second', undefined, installation)).toBeNull()
  })

  it('connects a second account through OIDC + PKCE without changing the original account or sign-in methods', async () => {
    const writer = instance()
    const reader = instance()
    const app = await http(writer)
    const headers = { authorization: 'Bearer console-session' }
    const url = '/me/social-identities/github/repo-access'
    expect((await app.inject({ method: 'POST', url: `${url}/authorization` })).statusCode).toBe(401)
    expect(await reader.identity.githubLoginFor('second', undefined, installation)).toBeNull()
    const begin = await app.inject({ method: 'POST', url: `${url}/authorization`, headers })
    expect(begin.statusCode).toBe(200)
    const { state, authorizationUri } = begin.json<{ state: string; authorizationUri: string }>()
    const authorization = new URL(authorizationUri)
    const completed = await app.inject({ method: 'POST', url, headers, payload: { code: 'code', state } })
    expect(completed.statusCode).toBe(200)
    const exchange = calls.find((call) => call.url.endsWith('/access_token'))!
    const verifier = (exchange.init!.body as URLSearchParams).get('code_verifier')!
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url')
    )
    expect(calls.at(-1)?.url).toBe('https://api.github.com/applications/Iv1.example/token')
    expect(await reader.identity.githubLoginFor('second', undefined, installation)).toBe('octocat')
    expect(await reader.identity.githubLoginFor('first', undefined, installation)).toBe('octocat')
    const profile = await app.inject({ url: '/me/social-identities', headers })
    expect(profile.json()).toMatchObject({
      identities: [{ target: 'google' }],
      githubRepoIdentity: { githubUserId: '123', login: 'octocat' }
    })
    expect((await app.inject({ method: 'POST', url: '/me/social-identities/refresh', headers })).statusCode).toBe(204)
    expect(await store.findBySubject('second')).not.toBeNull()
    expect((await app.inject({ method: 'DELETE', url: '/me/social-identities/google', headers })).statusCode).toBe(409)

    const authz = new GithubUserAuthzService({
      identity: reader.identity,
      clock,
      users: { getOidcSubject: async (id) => id },
      github: {
        getRepoMeta: async () => ({ private: true }),
        userRepoPermission: async (_ins, _owner, repo) => (repo === 'allowed' ? 'write' : 'none')
      }
    })
    const repos = [
      { fullName: 'example-org/allowed', private: true },
      { fullName: 'example-org/denied', private: true }
    ]
    expect(await authz.filterReposForUser('second', installation, repos)).toEqual({
      repos: [repos[0]],
      privateReposHidden: false
    })
    await expect(authz.assertAccess('second', installation, 'example-org', 'allowed', 'write')).resolves.toMatchObject({
      canWrite: true
    })
    await expect(authz.assertAccess('second', installation, 'example-org', 'denied', 'read')).rejects.toMatchObject({
      code: 'USER_NO_ACCESS'
    })
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(204)
    expect(await reader.identity.githubLoginFor('second', undefined, installation)).toBeNull()
    expect(await reader.identity.githubLoginFor('first', undefined, installation)).toBe('octocat')
  })

  it('shares a numeric identity across AC users and resolves renamed handles by id', async () => {
    const service = instance()
    for (const sub of ['second', 'third']) {
      const { state } = await service.repo.authorize(sub, sub)
      await service.repo.complete(sub, sub, 'code', state)
    }
    expect(await prisma.githubRepoIdentity.count()).toBe(2)
    github.userById.mockResolvedValue({ id: 123n, login: 'renamed' })
    expect(await service.identity.githubLoginFor('second', undefined, installation)).toBe('renamed')
    expect(github.userById).toHaveBeenCalledWith(installation, 123n)
    await prisma.user.delete({ where: { id: 'second' } })
    expect(await prisma.githubRepoIdentity.count()).toBe(1)
  })

  it('rejects foreign, replayed, expired and disconnected states without creating a binding', async () => {
    const { repo } = instance()
    const first = await repo.authorize('second', 'second')
    await expect(repo.complete('third', 'third', 'code', first.state)).rejects.toMatchObject({ status: 400 })
    await repo.complete('second', 'second', 'code', first.state)
    await expect(repo.complete('second', 'second', 'code', first.state)).rejects.toMatchObject({ status: 400 })
    await repo.disconnect('second')
    const expired = await repo.authorize('second', 'second')
    clock.advance(10 * 60_000)
    await expect(repo.complete('second', 'second', 'code', expired.state)).rejects.toMatchObject({ status: 400 })
    const cancelled = await repo.authorize('second', 'second')
    await repo.disconnect('second')
    await expect(repo.complete('second', 'second', 'code', cancelled.state)).rejects.toMatchObject({ status: 400 })
    expect(await store.findBySubject('second')).toBeNull()
    await repo.authorize('second', 'second')
    await prisma.user.delete({ where: { id: 'second' } })
    expect(await prisma.githubRepoIdentityState.count()).toBe(0)
  })

  it('serializes callback completion with disconnect across CP instances', async () => {
    const first = instance()
    const second = instance()
    const entered = deferred()
    const release = deferred()
    beforeExchange = async () => {
      entered.resolve()
      await release.promise
    }
    const { state } = await first.repo.authorize('second', 'second')
    const completing = first.repo.complete('second', 'second', 'code', state)
    await entered.promise
    const disconnecting = second.repo.disconnect('second')
    release.resolve()
    await Promise.all([completing, disconnecting])
    expect(await store.findBySubject('second')).toBeNull()
    expect(await prisma.githubRepoIdentityState.count()).toBe(0)
  })

  it('requires the authorization state to survive until the binding transaction commits', async () => {
    const { repo } = instance()
    const entered = deferred()
    const release = deferred()
    beforeExchange = async () => {
      entered.resolve()
      await release.promise
    }
    const { state } = await repo.authorize('second', 'second')
    const completing = repo.complete('second', 'second', 'code', state)
    await entered.promise
    // Simulate cancellation after the outer advisory-lock transaction has lost its lease.
    await store.clearBySubject('second')
    release.resolve()
    await expect(completing).rejects.toMatchObject({ status: 400 })
    expect(await store.findBySubject('second')).toBeNull()
  })

  it('preserves social priority and removes hidden fallback records before unlinking GitHub', async () => {
    const { repo, identity } = instance()
    const { state } = await repo.authorize('second', 'second')
    await repo.complete('second', 'second', 'code', state)
    users.get('second')!.github = { details: { rawData: { login: 'social-account' } } }
    identity.forgetUser('second')
    expect(await identity.githubLoginFor('second', 0, installation)).toBe('social-account')
    expect((await identity.socialAccountFor('second')).githubRepoIdentity).toBeUndefined()
    expect(github.userById).not.toHaveBeenCalled()
    await expect(repo.authorize('second', 'second')).rejects.toMatchObject({ code: 'GITHUB_ALREADY_LINKED' })
    await identity.unlinkSocialIdentity('second', 'github')
    expect(await identity.githubLoginFor('second', 0, installation)).toBeNull()
    expect(await store.findBySubject('second')).toBeNull()
  })

  it('fails closed on provider deletion/outage and never saves malformed OAuth identities', async () => {
    const { repo, identity } = instance()
    const { state } = await repo.authorize('second', 'second')
    malformedUser = true
    await expect(repo.complete('second', 'second', 'code', state)).rejects.toMatchObject({ status: 502 })
    expect(await store.findBySubject('second')).toBeNull()
    expect(calls.at(-1)?.init?.method).toBe('DELETE')
    await prisma.githubRepoIdentity.create({ data: { userId: 'second', githubUserId: 123n, login: 'octocat' } })
    providerStatus = 503
    await expect(identity.githubLoginFor('second', 0, installation)).rejects.toMatchObject({ status: 503 })
    users.delete('second')
    expect(await identity.githubLoginFor('second', 0, installation)).toBeNull()
    expect(github.userById).not.toHaveBeenCalled()
  })
})
