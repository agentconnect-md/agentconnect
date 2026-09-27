/**
 * `/me/keys` — the caller's own personal API keys (daemon-api-key-auth.md §8).
 *
 * Under the devAuth stub the principal is the seeded owner of the default org, so
 * a request with NO Authorization header acts as that owner. A request carrying
 * `Authorization: Bearer <key>` is instead authenticated as the personal key —
 * which is how these tests prove a minted key is a live credential, is bound to
 * its org, and dies on revoke.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

interface Minted {
  apiKeyId: string
  apiKey: string
  displayTail: string
  permission: 'full' | 'read' | 'agent:chat'
  allAgents: boolean
  agentIds: string[]
}
interface KeyRow {
  id: string
  displayTail: string
  name: string | null
  orgId: string
  orgSlug: string
  orgName: string | null
  permission: 'full' | 'read' | 'agent:chat'
  allAgents: boolean
  agentIds: string[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
const AGENT = 'a9a9a9a9-aaaa-4aaa-8aaa-a9a9a9a9a9a9'
const AGENT_B = 'b8b8b8b8-bbbb-4bbb-8bbb-b8b8b8b8b8b8'

/** Mint a key as the devAuth owner in the default org. */
async function mint(app: ReturnType<typeof buildHttpApp>['app'], body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID, ...body } })
}

describe('POST /me/keys — mint a personal key', () => {
  it('mints a user key in the chosen org, returns the plaintext once, and lists it', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        payload: { orgId: DEFAULT_ORG_ID, name: 'ci-runner' }
      })
      expect(res.statusCode).toBe(201)
      const minted = res.json() as Minted
      expect(minted.apiKey.length).toBeGreaterThan(40) // <secret><crc>
      expect(minted.displayTail).toMatch(/^…/)

      // The plaintext is never stored — only its peppered hash.
      const row = await prisma.apiKey.findUnique({ where: { id: minted.apiKeyId } })
      expect(row?.principalType).toBe('user')
      expect(row?.userId).toBe(DEFAULT_OWNER_ID)
      expect(row?.daemonId).toBeNull()
      expect(row?.hash).not.toBe(minted.apiKey)
      expect(row?.expiresAt).not.toBeNull() // user keys expire (default 90d)

      const list = await app.inject({ method: 'GET', url: '/api/v1/me/keys' })
      expect(list.statusCode).toBe(200)
      const keys = list.json() as KeyRow[]
      expect(keys).toHaveLength(1)
      expect(keys[0]!.id).toBe(minted.apiKeyId)
      expect(keys[0]!.name).toBe('ci-runner')
      expect(keys[0]!.orgId).toBe(DEFAULT_ORG_ID)
      expect(keys[0]!.orgSlug).toBe(DEFAULT_ORG_SLUG)
      expect(keys[0]!.revokedAt).toBeNull()
    } finally {
      await close()
    }
  })

  it('rejects an org the caller does not belong to (404)', async () => {
    // A stranger's own org — the seeded owner is not a member.
    const stranger = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'sub-stranger',
      email: 'stranger@example.test',
      emailVerified: true
    })
    const strangerOrg = await new PgOrgRepo(prisma).create({
      name: null,
      slug: 'stranger-org',
      ownerUserId: stranger.userId
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        payload: { orgId: strangerOrg.id }
      })
      expect(res.statusCode).toBe(404)
      // Nothing was minted for the stranger's org.
      const count = await prisma.apiKey.count({ where: { orgId: strangerOrg.id } })
      expect(count).toBe(0)
    } finally {
      await close()
    }
  })

  it('validates the expiry window (1–365 days)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      for (const bad of [0, 366, -5]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/me/keys',
          payload: { orgId: DEFAULT_ORG_ID, expiresInDays: bad }
        })
        expect(res.statusCode).toBe(400)
      }
    } finally {
      await close()
    }
  })

  it('mints a non-expiring key when expiresInDays is null', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        payload: { orgId: DEFAULT_ORG_ID, expiresInDays: null }
      })
      expect(res.statusCode).toBe(201)
      const minted = res.json() as Minted

      // A null TTL persists as a NULL expiry — the key never expires (like daemon keys).
      const row = await prisma.apiKey.findUnique({ where: { id: minted.apiKeyId } })
      expect(row?.expiresAt).toBeNull()

      const list = await app.inject({ method: 'GET', url: '/api/v1/me/keys' })
      const keys = list.json() as KeyRow[]
      expect(keys.find((k) => k.id === minted.apiKeyId)?.expiresAt).toBeNull()
    } finally {
      await close()
    }
  })
})

describe('a minted key is a live REST credential', () => {
  it('authenticates as the owner, but only in the org it is bound to', async () => {
    // A second org the owner ALSO belongs to — the key must still not reach it.
    const otherOrg = await new PgOrgRepo(prisma).create({
      name: null,
      slug: 'owner-second-org',
      ownerUserId: DEFAULT_OWNER_ID
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      const minted = (
        await app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
      ).json() as Minted

      // Identity route: the key resolves to the owner.
      const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(minted.apiKey) })
      expect(me.statusCode).toBe(200)
      expect((me.json() as { userId: string }).userId).toBe(DEFAULT_OWNER_ID)

      // Org-scoped route in the KEY'S org → allowed.
      const inOrg = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
        headers: bearer(minted.apiKey)
      })
      expect(inOrg.statusCode).toBe(200)

      // Same owner, DIFFERENT org → the key is bound to its org, so 404.
      const otherOrgRes = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${otherOrg.id}/agents`,
        headers: bearer(minted.apiKey)
      })
      expect(otherOrgRes.statusCode).toBe(404)
    } finally {
      await close()
    }
  })

  it('cannot be used to mint more keys (no self-propagation)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const minted = (
        await app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
      ).json() as Minted
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        headers: bearer(minted.apiKey),
        payload: { orgId: DEFAULT_ORG_ID }
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await close()
    }
  })

  it('rejects a malformed bearer key (401)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
        headers: bearer('not-a-real-key-000000')
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await close()
    }
  })
})

describe('DELETE /me/keys/:id — revoke', () => {
  it('revokes the caller’s own key and the key stops authenticating', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const minted = (
        await app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
      ).json() as Minted

      const del = await app.inject({ method: 'DELETE', url: `/api/v1/me/keys/${minted.apiKeyId}` })
      expect(del.statusCode).toBe(200)
      expect((del.json() as KeyRow).revokedAt).not.toBeNull()

      const list = await app.inject({ method: 'GET', url: '/api/v1/me/keys' })
      expect(list.statusCode).toBe(200)
      expect((list.json() as KeyRow[]).some((k) => k.id === minted.apiKeyId)).toBe(false)

      const again = await app.inject({ method: 'DELETE', url: `/api/v1/me/keys/${minted.apiKeyId}` })
      expect(again.statusCode).toBe(200)
      expect((again.json() as KeyRow).revokedAt).not.toBeNull()

      // The revoked key no longer authenticates.
      const after = await app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(minted.apiKey) })
      expect(after.statusCode).toBe(401)
    } finally {
      await close()
    }
  })

  it('cannot revoke another user’s key (reads as absent, 404)', async () => {
    // A key owned by someone else — the devAuth owner must not be able to kill it.
    const other = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'sub-other',
      email: 'other@acme.dev',
      emailVerified: true
    })
    const foreign = await prisma.apiKey.create({
      data: {
        principalType: 'user',
        orgId: DEFAULT_ORG_ID,
        userId: other.userId,
        hash: 'foreign-hash-value',
        displayTail: '…zzzz'
      }
    })
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/me/keys/${foreign.id}` })
      expect(res.statusCode).toBe(404)
      const row = await prisma.apiKey.findUnique({ where: { id: foreign.id } })
      expect(row?.revokedAt).toBeNull() // untouched
    } finally {
      await close()
    }
  })

  it('404s on an unknown key id', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: '/api/v1/me/keys/does-not-exist' })
      expect(res.statusCode).toBe(404)
    } finally {
      await close()
    }
  })
})

// ── key permissions and agent selection (daemon-api-key-auth.md §6) ──

describe('POST /me/keys — permission and agent selection', () => {
  it('defaults to full, reports the permission, and rejects a selection on a non-agent-level permission', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const full = (await mint(app, {})).json() as Minted
      expect(full.permission).toBe('full')
      expect(full.allAgents).toBe(false)
      expect(full.agentIds).toEqual([])

      const read = await mint(app, { permission: 'read' })
      expect(read.statusCode).toBe(201)
      expect((read.json() as Minted).permission).toBe('read')

      // `full` and `read` cover every agent, so a selection is a contradiction, not a hint.
      expect((await mint(app, { permission: 'full', agents: 'all' })).statusCode).toBe(400)
      expect((await mint(app, { permission: 'read', agents: [AGENT] })).statusCode).toBe(400)
      // An agent-level permission needs its selection; an empty list is not one.
      expect((await mint(app, { permission: 'agent:chat' })).statusCode).toBe(400)
      expect((await mint(app, { permission: 'agent:chat', agents: [] })).statusCode).toBe(400)
      expect((await mint(app, { permission: 'nope' })).statusCode).toBe(400)

      const list = (await app.inject({ method: 'GET', url: '/api/v1/me/keys' })).json() as KeyRow[]
      expect(list.map((k) => k.permission).sort()).toEqual(['full', 'read'])
    } finally {
      await close()
    }
  })

  it('stores the agent selection: all agents, or exactly the visible agents of the key’s org', async () => {
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, AGENT_B, { name: 'agent-b' })
    const { app, close } = buildHttpApp(prisma)
    try {
      const all = (await mint(app, { permission: 'agent:chat', agents: 'all' })).json() as Minted
      expect(all).toMatchObject({ permission: 'agent:chat', allAgents: true, agentIds: [] })

      const some = await mint(app, { permission: 'agent:chat', agents: [AGENT, AGENT, AGENT_B] })
      expect(some.statusCode).toBe(201)
      const someKey = some.json() as Minted
      expect(someKey.allAgents).toBe(false)
      expect([...someKey.agentIds].sort()).toEqual([AGENT, AGENT_B].sort())
      expect(await prisma.apiKeyAgent.count({ where: { apiKeyId: someKey.apiKeyId } })).toBe(2)

      // An unknown agent, or one in another org, reads as absent and nothing is minted.
      expect((await mint(app, { permission: 'agent:chat', agents: [randomUUID()] })).statusCode).toBe(404)
      const otherOrg = await new PgOrgRepo(prisma).create({
        name: null,
        slug: 'other-org',
        ownerUserId: DEFAULT_OWNER_ID
      })
      const FOREIGN = 'c7c7c7c7-cccc-4ccc-8ccc-c7c7c7c7c7c7'
      await seedAgent(prisma, FOREIGN, { name: 'foreign', orgId: otherOrg.id })
      expect((await mint(app, { permission: 'agent:chat', agents: [FOREIGN] })).statusCode).toBe(404)
      expect(await prisma.apiKey.count({ where: { orgId: DEFAULT_ORG_ID } })).toBe(2)

      const list = (await app.inject({ method: 'GET', url: '/api/v1/me/keys' })).json() as KeyRow[]
      const listed = list.find((k) => k.id === someKey.apiKeyId)!
      expect([...listed.agentIds].sort()).toEqual([AGENT, AGENT_B].sort())
    } finally {
      await close()
    }
  })

  it('a read key is admitted on GET and refused on every write, /me/keys included', async () => {
    await seedAgent(prisma, AGENT)
    const { app, close } = buildHttpApp(prisma)
    try {
      const read = (await mint(app, { permission: 'read' })).json() as Minted
      const agents = await app.inject({
        method: 'GET',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
        headers: bearer(read.apiKey)
      })
      expect(agents.statusCode).toBe(200)
      const own = await app.inject({ method: 'GET', url: '/api/v1/me/keys', headers: bearer(read.apiKey) })
      expect(own.statusCode).toBe(200)

      const mintWithKey = await app.inject({
        method: 'POST',
        url: '/api/v1/me/keys',
        headers: bearer(read.apiKey),
        payload: { orgId: DEFAULT_ORG_ID }
      })
      expect(mintWithKey.statusCode).toBe(403)
      expect((mintWithKey.json() as { message: string }).message).toContain('read-only')

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${AGENT}`,
        headers: bearer(read.apiKey)
      })
      expect(del.statusCode).toBe(403)
      expect(await prisma.agent.count({ where: { id: AGENT } })).toBe(1)
    } finally {
      await close()
    }
  })

  it('an agent:chat key is refused on every undeclared route, reads and /me/* included', async () => {
    await seedAgent(prisma, AGENT)
    const { app, close } = buildHttpApp(prisma)
    try {
      const chat = (await mint(app, { permission: 'agent:chat', agents: 'all' })).json() as Minted
      for (const url of [`/api/v1/orgs/${DEFAULT_ORG_ID}/agents`, '/api/v1/me/keys', '/api/v1/me']) {
        const res = await app.inject({ method: 'GET', url, headers: bearer(chat.apiKey) })
        expect(res.statusCode, url).toBe(403)
        expect((res.json() as { message: string }).message).toContain('agent:chat')
      }
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${AGENT}`,
        headers: bearer(chat.apiKey)
      })
      expect(del.statusCode).toBe(403)
    } finally {
      await close()
    }
  })

  it('a selection shrinks with agent deletion, and a row from before the column reads as full', async () => {
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, AGENT_B, { name: 'agent-b' })
    const { app, close } = buildHttpApp(prisma)
    try {
      const chat = (await mint(app, { permission: 'agent:chat', agents: [AGENT_B] })).json() as Minted
      await prisma.agent.delete({ where: { id: AGENT_B } })
      expect(await prisma.apiKeyAgent.count({ where: { apiKeyId: chat.apiKeyId } })).toBe(0)
      const list = (await app.inject({ method: 'GET', url: '/api/v1/me/keys' })).json() as KeyRow[]
      expect(list.find((k) => k.id === chat.apiKeyId)).toMatchObject({ allAgents: false, agentIds: [] })

      // A row written without the new columns carries their defaults, exactly like a row the migration backfilled.
      const legacy = await prisma.apiKey.create({
        data: {
          principalType: 'user',
          orgId: DEFAULT_ORG_ID,
          userId: DEFAULT_OWNER_ID,
          hash: 'legacy-hash',
          displayTail: '…lgcy'
        }
      })
      expect(legacy.permission).toBe('full')
      const after = (await app.inject({ method: 'GET', url: '/api/v1/me/keys' })).json() as KeyRow[]
      expect(after.find((k) => k.id === legacy.id)).toMatchObject({
        permission: 'full',
        allAgents: false,
        agentIds: []
      })
    } finally {
      await close()
    }
  })
})
