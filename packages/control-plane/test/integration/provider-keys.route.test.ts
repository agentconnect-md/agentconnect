import { PROVIDER_KEY_PROFILES } from '@agentconnect.md/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgProviderKeyStore } from '../../src/persistence/repositories/provider-key.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const BASE = `/api/v1/orgs/${DEFAULT_ORG_ID}/provider-keys`
const opened: HttpApp[] = []
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close()
})

function makeApp(userId = DEFAULT_OWNER_ID) {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(app)
  return app
}

describe('organization provider keys', () => {
  it('configures OpenRouter and Cloudflare endpoints and patches secret headers without resubmitting a key', async () => {
    const { app, deps } = makeApp()
    const cipher = {
      seal: vi.fn(async (value: string) => `sealed:${value}`),
      open: vi.fn(async (value: string) => value.slice(7))
    }
    const store = new PgProviderKeyStore(prisma, cipher)
    deps.repos.providerKey = store
    expect(
      (await app.inject({ method: 'GET', url: BASE })).json().map((row: { provider: string }) => row.provider)
    ).toEqual(['typesafe', 'openrouter', 'cloudflare'])
    expect(
      (await app.inject({ method: 'PUT', url: `${BASE}/openrouter`, payload: { headers: { 'X-Title': 'Example' } } }))
        .statusCode
    ).toBe(400)
    expect(
      (await app.inject({ method: 'PUT', url: `${BASE}/openrouter`, payload: { apiKey: 'example-router-key' } }))
        .statusCode
    ).toBe(200)
    const url = `${BASE}/cloudflare`
    expect((await app.inject({ method: 'PUT', url, payload: { apiKey: 'example-gateway-key' } })).statusCode).toBe(400)
    const endpoint = 'https://gateway.example.test/v1'
    const created = await app.inject({
      method: 'PUT',
      url,
      payload: {
        apiKey: 'example-gateway-key',
        endpoint,
        headers: { 'CF-AIG-Authorization': 'Bearer example-token', 'X-Route': 'example-route' }
      }
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ endpoint, headerNames: ['cf-aig-authorization', 'x-route'] })
    expect(created.body).not.toContain('example-token')
    const patched = await app.inject({
      method: 'PUT',
      url,
      payload: { endpoint, headers: { 'X-Route': null, 'X-Account': 'example-account' } }
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().headerNames).toEqual(['cf-aig-authorization', 'x-account'])
    const listed = await app.inject({ method: 'GET', url: BASE })
    expect(listed.body).not.toContain('example-token')
    expect(listed.body).not.toContain('example-gateway-key')
    expect(cipher.open).not.toHaveBeenCalled()
    expect(await store.get(OrgId(DEFAULT_ORG_ID), 'cloudflare')).toEqual({
      apiKey: 'example-gateway-key',
      endpoint,
      headers: { 'cf-aig-authorization': 'Bearer example-token', 'x-account': 'example-account' }
    })
    expect((await prisma.providerKeyHeader.findMany()).every((header) => header.value.startsWith('sealed:'))).toBe(true)
    cipher.seal.mockRejectedValue(new Error('example-failed-header'))
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: { endpoint: 'https://changed.example.test', headers: { 'X-Account': 'example-failed-header' } }
        })
      ).statusCode
    ).toBe(503)
    expect((await store.get(OrgId(DEFAULT_ORG_ID), 'cloudflare'))!.endpoint).toBe(endpoint)
    await app.inject({ method: 'DELETE', url })
    expect(await prisma.providerKeyHeader.count()).toBe(0)
    expect(await store.get(OrgId(DEFAULT_ORG_ID), 'cloudflare')).toBeNull()
  })

  it('saves, replaces and removes one write-only default using the org-scoped cipher', async () => {
    const { app, deps } = makeApp()
    const cipher = {
      seal: vi.fn(async (value: string) => `sealed:${value}`),
      open: vi.fn(async (value: string) => value.slice('sealed:'.length))
    }
    const store = new PgProviderKeyStore(prisma, cipher)
    deps.repos.providerKey = store
    const empty = {
      provider: 'typesafe',
      ...PROVIDER_KEY_PROFILES.typesafe,
      endpoint: null,
      headerNames: [],
      configured: false,
      updatedAt: null
    }
    expect((await app.inject({ method: 'GET', url: BASE })).json()[0]).toEqual(empty)

    for (const apiKey of ['example-first-key', 'example-replacement-key']) {
      const result = await app.inject({ method: 'PUT', url: `${BASE}/typesafe`, payload: { apiKey } })
      expect(result.statusCode).toBe(200)
      expect(result.json()).toEqual({ ...empty, configured: true, updatedAt: expect.any(String) })
      expect(result.body).not.toContain(apiKey)
      const listed = await app.inject({ method: 'GET', url: BASE })
      expect(listed.json()[0]).toEqual(result.json())
      expect(listed.body).not.toContain(apiKey)
      expect(cipher.open).not.toHaveBeenCalled()
      expect(cipher.seal).toHaveBeenLastCalledWith(apiKey, { kind: 'org', orgId: DEFAULT_ORG_ID })
      expect(await prisma.providerKey.count()).toBe(1)
      expect((await prisma.providerKey.findFirstOrThrow()).value).toBe(`sealed:${apiKey}`)
    }

    expect(await store.get(OrgId(DEFAULT_ORG_ID), 'typesafe')).toEqual({
      apiKey: 'example-replacement-key',
      endpoint: null,
      headers: {}
    })
    expect(await store.get(OrgId('another-org'), 'typesafe')).toBeNull()
    for (let n = 0; n < 2; n++)
      expect((await app.inject({ method: 'DELETE', url: `${BASE}/typesafe` })).statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: BASE })).json()[0]).toEqual(empty)
    expect(await store.get(OrgId(DEFAULT_ORG_ID), 'typesafe')).toBeNull()
  })

  it('allows member status reads but only owners can write, with organization isolation', async () => {
    const owner = makeApp()
    await owner.app.inject({ method: 'PUT', url: `${BASE}/typesafe`, payload: { apiKey: 'example-owner-key' } })
    for (const role of ['viewer', 'collaborator'] as const) {
      const users = new PgUserRepo(prisma)
      const email = `${role}@example.test`
      const { userId } = await users.provisionOidcUser({ oidcSubject: role, email, emailVerified: true })
      await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
      const { app } = makeApp(userId)
      expect((await app.inject({ method: 'GET', url: BASE })).statusCode).toBe(200)
      expect(
        (await app.inject({ method: 'PUT', url: `${BASE}/typesafe`, payload: { apiKey: 'example-denied-key' } }))
          .statusCode
      ).toBe(403)
      expect((await app.inject({ method: 'DELETE', url: `${BASE}/typesafe` })).statusCode).toBe(403)
    }
    const other = await prisma.org.create({
      data: { slug: 'other-provider-org', members: { create: { userId: DEFAULT_OWNER_ID, role: 'owner' } } }
    })
    const otherBase = `/api/v1/orgs/${other.id}/provider-keys`
    expect((await owner.app.inject({ method: 'GET', url: otherBase })).json()[0].configured).toBe(false)
    await owner.app.inject({ method: 'PUT', url: `${otherBase}/typesafe`, payload: { apiKey: 'example-other-key' } })
    await owner.app.inject({ method: 'DELETE', url: `${otherBase}/typesafe` })
    expect((await owner.app.inject({ method: 'GET', url: BASE })).json()[0].configured).toBe(true)
    expect((await prisma.providerKey.findFirstOrThrow()).value).toBe('example-owner-key')
    const { userId: outsiderId } = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'outsider',
      email: 'outsider@example.test',
      emailVerified: true
    })
    const outsider = makeApp(outsiderId)
    expect((await outsider.app.inject({ method: 'GET', url: BASE })).statusCode).toBe(404)
    expect(
      (await outsider.app.inject({ method: 'PUT', url: `${BASE}/typesafe`, payload: { apiKey: 'example-denied-key' } }))
        .statusCode
    ).toBe(404)
    expect((await outsider.app.inject({ method: 'DELETE', url: `${BASE}/typesafe` })).statusCode).toBe(404)
  })

  it('rejects invalid input and keeps failures secret without removing an existing key', async () => {
    const { app, deps } = makeApp()
    const cipher = { seal: vi.fn(async (value: string) => value), open: vi.fn(async (value: string) => value) }
    const store = new PgProviderKeyStore(prisma, cipher)
    deps.repos.providerKey = store
    for (const payload of [
      { endpoint: 'not a url' },
      { endpoint: 'https://user:secret@example.test/v1' },
      { endpoint: 'https://api.example.test/v1?key=example-secret' },
      { endpoint: 'file:///tmp/key' },
      { headers: { 'Bad Header': 'value' } },
      { headers: { 'X-Value': 'one\r\nTwo: three' } },
      { headers: { 'X-Key': 'one', 'x-key': 'two' } }
    ])
      expect(
        (await app.inject({ method: 'PUT', url: `${BASE}/typesafe`, payload: { apiKey: 'example-key', ...payload } }))
          .statusCode
      ).toBe(400)
    for (const apiKey of ['', '   ', 'line\nbreak', 'x'.repeat(8193)]) {
      expect((await app.inject({ method: 'PUT', url: `${BASE}/typesafe`, payload: { apiKey } })).statusCode).toBe(400)
    }
    expect(
      (await app.inject({ method: 'PUT', url: `${BASE}/unknown`, payload: { apiKey: 'example-key' } })).statusCode
    ).toBe(400)
    await app.inject({ method: 'PUT', url: `${BASE}/typesafe`, payload: { apiKey: 'example-saved-key' } })
    cipher.seal.mockRejectedValue(new Error('unavailable: example-secret-failed-write'))
    const result = await app.inject({
      method: 'PUT',
      url: `${BASE}/typesafe`,
      payload: { apiKey: 'example-secret-failed-write' }
    })
    expect(result.statusCode).toBe(503)
    expect(result.body).not.toContain('example-secret-failed-write')
    expect((await prisma.providerKey.findFirstOrThrow()).value).toBe('example-saved-key')
    expect((await app.inject({ method: 'GET', url: BASE })).json()[0].configured).toBe(true)
    cipher.open.mockRejectedValue(new Error('cipher unavailable'))
    await expect(store.get(OrgId(DEFAULT_ORG_ID), 'typesafe')).rejects.toThrow('cipher unavailable')
  })
})
