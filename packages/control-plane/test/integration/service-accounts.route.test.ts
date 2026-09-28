// `/service-accounts` — service-account members (daemon-api-key-auth.md §6); devAuth acts as the default org's owner.
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

interface Account {
  userId: string
  name: string
  email: string
  displayName: string
  role: string
  createdAt: string
}

type App = ReturnType<typeof buildHttpApp>['app']

async function createAccount(app: App, body: Record<string, unknown> = { name: 'docs-bot' }): Promise<Account> {
  const res = await app.inject({ method: 'POST', url: `${ORG}/service-accounts`, payload: body })
  expect(res.statusCode).toBe(201)
  return res.json() as Account
}

async function mintKey(app: App, accountId: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `${ORG}/service-accounts/${accountId}/keys`, payload: body })
  expect(res.statusCode).toBe(201)
  return (res.json() as { apiKey: string }).apiKey
}

describe('service accounts', () => {
  it('creates a member with a fixed address that the member list leaves out', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const account = await createAccount(app, { name: 'docs-bot', role: 'viewer' })
      expect(account.email).toBe(`docs-bot-${account.userId}@sa.agentconnect.md`)
      expect(account).toMatchObject({ name: 'docs-bot', displayName: 'docs-bot', role: 'viewer' })

      const members = (await app.inject({ method: 'GET', url: `${ORG}/members` })).json() as { userId: string }[]
      expect(members.map((m) => m.userId)).not.toContain(account.userId)
      const listed = (await app.inject({ method: 'GET', url: `${ORG}/service-accounts` })).json() as Account[]
      expect(listed.map((a) => a.userId)).toEqual([account.userId])

      const edited = await app.inject({
        method: 'PATCH',
        url: `${ORG}/service-accounts/${account.userId}`,
        payload: { displayName: 'Docs site', role: 'collaborator' }
      })
      expect(edited.statusCode).toBe(200)
      expect(edited.json()).toMatchObject({ name: 'docs-bot', displayName: 'Docs site', role: 'collaborator' })
    } finally {
      await close()
    }
  })

  it('refuses the owner role and a name outside the address alphabet', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      for (const payload of [{ name: 'bot', role: 'owner' }, { name: 'Docs Bot' }]) {
        const res = await app.inject({ method: 'POST', url: `${ORG}/service-accounts`, payload })
        expect(res.statusCode).toBe(400)
      }
      const account = await createAccount(app)
      const promote = await app.inject({
        method: 'PATCH',
        url: `${ORG}/service-accounts/${account.userId}`,
        payload: { role: 'owner' }
      })
      expect(promote.statusCode).toBe(400)
    } finally {
      await close()
    }
  })

  it('is owner-only', async () => {
    const email = `collab-${randomUUID()}@example.test`
    const { userId } = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: email,
      email,
      emailVerified: true
    })
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
    const { app, close } = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
    try {
      const res = await app.inject({ method: 'POST', url: `${ORG}/service-accounts`, payload: { name: 'bot' } })
      expect(res.statusCode).toBe(403)
    } finally {
      await close()
    }
  })

  it('mints a key that acts as the account and cannot manage keys, orgs, or its membership', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const account = await createAccount(app)
      const key = await mintKey(app, account.userId, { name: 'docs-site' })
      const row = await prisma.apiKey.findFirstOrThrow({ where: { userId: account.userId } })
      expect(row.createdByUserId).toBe(DEFAULT_OWNER_ID)

      expect((await app.inject({ method: 'GET', url: `${ORG}/agents`, headers: bearer(key) })).statusCode).toBe(200)
      const refused = [
        { method: 'POST' as const, url: '/api/v1/orgs', payload: { slug: `sa-${randomUUID().slice(0, 8)}` } },
        { method: 'GET' as const, url: '/api/v1/me/keys' },
        { method: 'GET' as const, url: `${ORG}/service-accounts` },
        { method: 'POST' as const, url: `${ORG}/service-accounts/${account.userId}/keys`, payload: {} }
      ]
      for (const req of refused) {
        expect((await app.inject({ ...req, headers: bearer(key) })).statusCode, req.url).toBe(403)
      }
      const leave = await app.inject({
        method: 'DELETE',
        url: `${ORG}/members/${account.userId}`,
        headers: bearer(key)
      })
      expect(leave.statusCode).toBe(404)
    } finally {
      await close()
    }
  })

  it('answers 404 from the member routes for a service account', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const account = await createAccount(app)
      const base = `${ORG}/members/${account.userId}`
      expect((await app.inject({ method: 'PATCH', url: base, payload: { role: 'owner' } })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `${base}/removal-preview` })).statusCode).toBe(404)
      expect((await app.inject({ method: 'DELETE', url: base })).statusCode).toBe(404)
      expect(await prisma.membership.count({ where: { userId: account.userId } })).toBe(1)
    } finally {
      await close()
    }
  })

  it('cannot be claimed, merged, or added to another org by its address', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const account = await createAccount(app)
      const users = new PgUserRepo(prisma)

      const first = await users.provisionOidcUser({
        oidcSubject: `sub-${randomUUID()}`,
        email: account.email,
        emailVerified: true
      })
      expect(first.userId).not.toBe(account.userId)

      const sub = `sub-${randomUUID()}`
      const late = await users.provisionOidcUser({ oidcSubject: sub })
      await users.provisionOidcUser({ oidcSubject: sub, email: account.email, emailVerified: true })
      expect(late.userId).not.toBe(account.userId)
      const survivor = await prisma.user.findUniqueOrThrow({ where: { id: account.userId } })
      expect(survivor.email).toBe(account.email)
      expect(survivor.oidcSubject).toBeNull()

      const add = await app.inject({ method: 'POST', url: `${ORG}/members`, payload: { email: account.email } })
      expect(add.statusCode).toBe(409)
    } finally {
      await close()
    }
  })

  it('deletes the account with its keys and hands an audience it alone held to the owner', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const account = await createAccount(app)
      const key = await mintKey(app, account.userId)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { visibility: 'restricted', sharedWith: [account.userId] })

      const res = await app.inject({ method: 'DELETE', url: `${ORG}/service-accounts/${account.userId}` })
      expect(res.statusCode).toBe(204)
      expect(await prisma.user.findUnique({ where: { id: account.userId } })).toBeNull()
      expect(await prisma.apiKey.count({ where: { userId: account.userId } })).toBe(0)
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
      expect(agent.sharedWith).toEqual([DEFAULT_OWNER_ID])
      expect((await app.inject({ method: 'GET', url: `${ORG}/agents`, headers: bearer(key) })).statusCode).toBe(401)
    } finally {
      await close()
    }
  })

  it('treats a person’s id as absent on the service-account routes', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'DELETE', url: `${ORG}/service-accounts/${DEFAULT_OWNER_ID}` })
      expect(res.statusCode).toBe(404)
      expect(await prisma.user.findUnique({ where: { id: DEFAULT_OWNER_ID } })).not.toBeNull()
    } finally {
      await close()
    }
  })
})
