// Computer screenshot storage (computer-use.md §9): signed uploads, retention, metering, and reads gated by session ∩ Computer visibility.
import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgComputerScreenshotRepo } from '../../src/persistence/repositories/computer-screenshot.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import {
  ComputerScreenshots,
  type ComputerScreenshotsOpts,
  ScreenshotSessionPendingError
} from '../../src/registry/computerScreenshots.js'
import type { ScreenshotBucket, ScreenshotObjectKey } from '../../src/computer-screenshots/bucket.js'
import { ComputerPolicySchema } from '../../src/domain/computer.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REGISTER = '/api/v1/computers/register'
const T0 = Date.parse('2026-10-21T10:00:00.000Z')
const DAY = 86_400_000
const SHA = 'ab'.repeat(32)

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

// An in-memory bucket: a signed PUT is "uploaded" by the test putting the key in `objects`.
class FakeBucket implements ScreenshotBucket {
  readonly maxBytes = 1024
  objects = new Map<string, number>()
  deleted: string[] = []
  failDelete = false
  async signPut(input: { key: ScreenshotObjectKey; bytes: number }) {
    return {
      url: `https://store.example.test/${input.key}?sig=put`,
      headers: { 'content-length': String(input.bytes) },
      expiresAt: T0 + 300_000
    }
  }
  async signGet(input: { key: ScreenshotObjectKey }) {
    return { url: `https://store.example.test/${input.key}?sig=get`, headers: {}, expiresAt: T0 + 300_000 }
  }
  async holds(input: { key: ScreenshotObjectKey; bytes: number }) {
    return this.objects.get(input.key) === input.bytes
  }
  async delete(key: ScreenshotObjectKey) {
    if (this.failDelete) throw new Error('store down')
    this.deleted.push(key)
    this.objects.delete(key)
  }
}

function harness(limits?: ComputerScreenshotsOpts['limits']) {
  const clock = new FakeClock(T0)
  const bucket = new FakeBucket()
  const repo = new PgComputerScreenshotRepo(prisma)
  const screenshots = new ComputerScreenshots(repo, new PgSessionRepo(prisma), bucket, clock, {
    defaultDays: 30,
    maxDays: 90,
    ...(limits ? { limits } : {})
  })
  return { clock, bucket, repo, screenshots }
}

function appAs(userId: string, screenshots?: ComputerScreenshots): HttpApp {
  const app = buildHttpApp(
    prisma,
    { DEFAULT_OWNER_ID: userId, PUBLIC_CP_URL: 'https://cp.example.com' },
    undefined,
    undefined,
    screenshots ? { computerScreenshots: screenshots } : {}
  )
  opened.push(app)
  return app
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@acme.dev`
  const { userId } = await new PgUserRepo(prisma).provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function register(app: HttpApp): Promise<string> {
  const issued = await app.app.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: {} })
  const { token } = issued.json() as { token: string }
  const res = await app.app.inject({
    method: 'POST',
    url: REGISTER,
    payload: {
      token,
      name: 'desk',
      os: 'linux',
      osVersion: 'Ubuntu 26.04',
      session: 'x11',
      desktopDaemonVersion: '0.1.0',
      driverVersion: '0.35.2'
    }
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { computerId: string }).computerId
}

async function session(visibility: 'org' | 'private' = 'org', ownerIdentity?: string) {
  const daemonId = await seedDaemon(prisma, randomUUID())
  const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
  const sessionId = await seedSessionMeta(prisma, `s-shot-${randomUUID()}`, agentId, {
    visibility,
    ...(ownerIdentity ? { ownerIdentity } : {})
  })
  return { agentId, sessionId }
}

const offer = (sessionId: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  agentId,
  sha256: SHA,
  bytes: 100,
  contentType: 'image/png' as const,
  takenAt: new Date(T0).toISOString(),
  ...extra
})

const policy = (over: Record<string, unknown> = {}) => ComputerPolicySchema.parse(over)
const granting = (agentId: string) => ({ mode: 'selected' as const, agents: [agentId] })

// Offer, upload and confirm one screenshot the way a desktop does.
async function store(
  h: ReturnType<typeof harness>,
  computerId: string,
  s: { agentId: string; sessionId: string },
  over: Record<string, unknown> = {}
) {
  const signed = await h.screenshots.put(
    { orgId: DEFAULT_ORG_ID, computerId, policy: policy(over), agentAccess: granting(s.agentId) },
    offer(s.sessionId, s.agentId)
  )
  expect(signed.status).toBe('upload')
  const key = new URL(signed.url!).pathname.slice(1)
  h.bucket.objects.set(key, 100)
  expect(await h.screenshots.commit(computerId, { sessionId: s.sessionId, sha256: SHA })).toBe(true)
  return key
}

describe('computer screenshot storage', () => {
  it('signs an upload, confirms it only once the bytes are there, and reuses it after', async () => {
    const h = harness()
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    const signed = await h.screenshots.put(
      { orgId: DEFAULT_ORG_ID, computerId, policy: policy(), agentAccess: granting(s.agentId) },
      offer(s.sessionId, s.agentId)
    )
    expect(signed).toMatchObject({ status: 'upload', headers: { 'content-length': '100' } })
    const key = new URL(signed.url!).pathname.slice(1)
    expect(key).toBe(`computer-screenshots/${DEFAULT_ORG_ID}/${computerId}/${s.sessionId}/${T0}-${SHA}.png`)
    // Nothing is readable or metered until the object holds exactly the announced bytes.
    expect(await h.screenshots.commit(computerId, { sessionId: s.sessionId, sha256: SHA })).toBe(false)
    h.bucket.objects.set(key, 100)
    expect(await h.screenshots.commit(computerId, { sessionId: s.sessionId, sha256: SHA })).toBe(true)
    const row = await prisma.computerScreenshot.findFirstOrThrow({ where: { computerId } })
    expect(row.storedAt).not.toBeNull()
    expect(row.expiresAt.getTime()).toBe(T0 + 30 * DAY)
    // The same bytes again in the session need no upload.
    const again = await h.screenshots.put(
      { orgId: DEFAULT_ORG_ID, computerId, policy: policy(), agentAccess: granting(s.agentId) },
      offer(s.sessionId, s.agentId)
    )
    expect(again).toEqual({ status: 'stored' })
  })

  it('meters a screenshot in the same transaction that marks it stored', async () => {
    const clock = new FakeClock(T0)
    const bucket = new FakeBucket()
    // A client whose transactions fail on the usage write: the stored mark must roll back with it.
    let failUsage = true
    const failingUsage = {
      upsert: async () => {
        throw new Error('usage write failed')
      }
    }
    const flaky = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'computerScreenshotUsage' && failUsage) return failingUsage
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver)
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.$transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(inner, key, r) {
                  if (key === 'computerScreenshotUsage' && failUsage) return failingUsage
                  return Reflect.get(inner, key, r)
                }
              })
            )
          )
      }
    })
    const screenshots = new ComputerScreenshots(
      new PgComputerScreenshotRepo(flaky),
      new PgSessionRepo(prisma),
      bucket,
      clock,
      {
        defaultDays: 30,
        maxDays: 90
      }
    )
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    const signed = await screenshots.put(
      { orgId: DEFAULT_ORG_ID, computerId, policy: policy(), agentAccess: granting(s.agentId) },
      offer(s.sessionId, s.agentId)
    )
    bucket.objects.set(new URL(signed.url!).pathname.slice(1), 100)
    await expect(screenshots.commit(computerId, { sessionId: s.sessionId, sha256: SHA })).rejects.toThrow()
    expect((await prisma.computerScreenshot.findFirstOrThrow({ where: { computerId } })).storedAt).toBeNull()
    failUsage = false
    expect(await screenshots.commit(computerId, { sessionId: s.sessionId, sha256: SHA })).toBe(true)
    const usage = await prisma.computerScreenshotUsage.findMany({ where: { orgId: DEFAULT_ORG_ID } })
    expect(usage.map((u) => [u.count, Number(u.bytes)])).toEqual([[1, 100]])
  })

  it('writes nothing with a retention of 0 and caps a policy at the deployment maximum', async () => {
    const h = harness()
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    const skipped = await h.screenshots.put(
      {
        orgId: DEFAULT_ORG_ID,
        computerId,
        policy: policy({ screenshotRetentionDays: 0 }),
        agentAccess: granting(s.agentId)
      },
      offer(s.sessionId, s.agentId)
    )
    expect(skipped.status).toBe('skipped')
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(0)
    expect(h.screenshots.retentionDays(policy({ screenshotRetentionDays: 400 }))).toBe(90)
    const tooBig = await h.screenshots.put(
      { orgId: DEFAULT_ORG_ID, computerId, policy: policy(), agentAccess: granting(s.agentId) },
      offer(s.sessionId, s.agentId, { bytes: 4096 })
    )
    expect(tooBig).toMatchObject({ status: 'skipped', reason: 'too large' })
  })

  it('holds an organization to its screenshot storage and retention quota', async () => {
    const h = harness(async () => ({ storedBytes: 150, retentionDays: 7 }))
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    await prisma.computer.update({ where: { id: computerId }, data: { kind: 'managed' } })
    const s = await session()
    const target = {
      orgId: DEFAULT_ORG_ID,
      computerId,
      kind: 'managed' as const,
      policy: policy(),
      agentAccess: granting(s.agentId)
    }
    const first = await h.screenshots.put(target, offer(s.sessionId, s.agentId))
    h.bucket.objects.set(new URL(first.url!).pathname.slice(1), 100)
    expect(await h.screenshots.commit(computerId, { sessionId: s.sessionId, sha256: SHA })).toBe(true)
    const row = await prisma.computerScreenshot.findFirstOrThrow({ where: { computerId } })
    expect(row.expiresAt.getTime()).toBe(T0 + 7 * DAY)
    expect(await h.screenshots.put(target, offer(s.sessionId, s.agentId, { sha256: 'b'.repeat(64) }))).toEqual({
      status: 'skipped',
      reason: 'screenshot storage quota reached'
    })
    // A self-hosted Computer is held to its own policy only.
    const own = { ...target, kind: 'self-hosted' as const, computerId: await register(appAs(DEFAULT_OWNER_ID)) }
    expect(await h.screenshots.put(own, offer(s.sessionId, s.agentId, { sha256: 'c'.repeat(64) }))).toMatchObject({
      status: 'upload'
    })
    expect(
      (await prisma.computerScreenshot.findFirstOrThrow({ where: { computerId: own.computerId } })).expiresAt
    ).toEqual(new Date(T0 + 30 * DAY))
  })

  it('shortens stored managed screenshots when the organization’s retention quota drops', async () => {
    let retentionDays: number | null = null
    const h = harness(async () => ({ storedBytes: null, retentionDays }))
    const managedId = await register(appAs(DEFAULT_OWNER_ID))
    await prisma.computer.update({ where: { id: managedId }, data: { kind: 'managed' } })
    const ownId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    for (const [computerId, kind] of [
      [managedId, 'managed'],
      [ownId, 'self-hosted']
    ] as const) {
      const signed = await h.screenshots.put(
        { orgId: DEFAULT_ORG_ID, computerId, kind, policy: policy(), agentAccess: granting(s.agentId) },
        offer(s.sessionId, s.agentId)
      )
      h.bucket.objects.set(new URL(signed.url!).pathname.slice(1), 100)
      expect(await h.screenshots.commit(computerId, { sessionId: s.sessionId, sha256: SHA })).toBe(true)
    }
    const expiry = async (computerId: string) =>
      (await prisma.computerScreenshot.findFirstOrThrow({ where: { computerId } })).expiresAt.getTime()
    expect(await expiry(managedId)).toBe(T0 + 30 * DAY)
    retentionDays = 7
    expect(await h.screenshots.applyOrgRetention(DEFAULT_ORG_ID)).toBe(1)
    expect(await expiry(managedId)).toBe(T0 + 7 * DAY)
    expect(await expiry(ownId)).toBe(T0 + 30 * DAY)
    // The reaper applies a lowered quota too, such as the deployment's plan default.
    retentionDays = 3
    await h.screenshots.reap()
    expect(await expiry(managedId)).toBe(T0 + 3 * DAY)
    expect(await expiry(ownId)).toBe(T0 + 30 * DAY)
  })

  it('serves a screenshot only to a member who can view both the session and the Computer', async () => {
    const h = harness()
    const dana = await makeUser(`shot-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`shot-erin-${randomUUID()}`, 'collaborator')
    const computerId = await register(appAs(dana))
    const s = await session()
    await store(h, computerId, s)
    const url = `${ORG}/sessions/${s.sessionId}/computer-screenshots/${SHA}`

    const read = await appAs(dana, h.screenshots).app.inject({ method: 'GET', url })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ ref: `sha256:${SHA}`, computerId, agentId: s.agentId, bytes: 100 })
    expect((read.json() as { url: string }).url).toContain('sig=get')
    const list = await appAs(dana, h.screenshots).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${s.sessionId}/computer-screenshots`
    })
    expect((list.json() as { screenshots: unknown[] }).screenshots).toHaveLength(1)

    // Erin sees the session but not the Computer, which is Selected with only its registrant.
    expect((await appAs(erin, h.screenshots).app.inject({ method: 'GET', url })).statusCode).toBe(404)
    const hidden = await appAs(erin, h.screenshots).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${s.sessionId}/computer-screenshots`
    })
    expect(hidden.json()).toEqual({ screenshots: [], nextCursor: null })

    // Shared with Erin, the Computer is visible, so the screenshot is too.
    const shared = await appAs(dana).app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [dana, erin] }
    })
    expect(shared.statusCode).toBe(200)
    expect((await appAs(erin, h.screenshots).app.inject({ method: 'GET', url })).statusCode).toBe(200)
  })

  it('hides a private session’s screenshots from a member who sees the Computer', async () => {
    const h = harness()
    const dana = await makeUser(`shot-priv-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`shot-priv-erin-${randomUUID()}`, 'collaborator')
    const computerId = await register(appAs(dana))
    await appAs(dana).app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    const s = await session('private', `user:${dana}`)
    await store(h, computerId, s)
    const url = `${ORG}/sessions/${s.sessionId}/computer-screenshots/${SHA}`
    expect((await appAs(dana, h.screenshots).app.inject({ method: 'GET', url })).statusCode).toBe(200)
    expect((await appAs(erin, h.screenshots).app.inject({ method: 'GET', url })).statusCode).toBe(404)
    const list = await appAs(erin, h.screenshots).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${s.sessionId}/computer-screenshots`
    })
    expect(list.statusCode).toBe(404)
  })

  it('collects expired screenshots objects first, keeps the usage, and retries a failed delete', async () => {
    const h = harness()
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    const key = await store(h, computerId, s, { screenshotRetentionDays: 1 })
    const usageUrl = `${ORG}/usage/computer-screenshots?from=${new Date(T0 - DAY).toISOString()}&to=${new Date(T0 + DAY).toISOString()}`
    const before = await appAs(DEFAULT_OWNER_ID, h.screenshots).app.inject({ method: 'GET', url: usageUrl })
    expect(before.json()).toMatchObject({ written: { count: 1, bytes: 100 }, stored: { count: 1, bytes: 100 } })

    h.clock.advance(DAY + 1000)
    // Expired reads as absent at once, before the reaper runs.
    const url = `${ORG}/sessions/${s.sessionId}/computer-screenshots/${SHA}`
    expect((await appAs(DEFAULT_OWNER_ID, h.screenshots).app.inject({ method: 'GET', url })).statusCode).toBe(404)
    h.bucket.failDelete = true
    expect(await h.screenshots.reap()).toBe(0)
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(1)
    h.bucket.failDelete = false
    expect(await h.screenshots.reap()).toBe(1)
    expect(h.bucket.deleted).toEqual([key])
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(0)

    const after = await appAs(DEFAULT_OWNER_ID, h.screenshots).app.inject({ method: 'GET', url: usageUrl })
    expect(after.json()).toMatchObject({ written: { count: 1, bytes: 100 }, stored: { count: 0, bytes: 0 } })
  })

  it('collects an unconfirmed upload after an hour and a deleted Computer’s screenshots', async () => {
    const h = harness()
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    await h.screenshots.put(
      { orgId: DEFAULT_ORG_ID, computerId, policy: policy(), agentAccess: granting(s.agentId) },
      offer(s.sessionId, s.agentId, { sha256: 'cd'.repeat(32) })
    )
    await store(h, computerId, s)
    expect(await h.screenshots.reap()).toBe(0)
    h.clock.advance(3_600_000 + 1000)
    expect(await h.screenshots.reap()).toBe(1)
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(1)

    const del = await appAs(DEFAULT_OWNER_ID).app.inject({ method: 'DELETE', url: `${ORG}/computers/${computerId}` })
    expect(del.statusCode).toBeLessThan(300)
    expect(await h.screenshots.reap()).toBe(1)
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(0)
  })

  it('signs nothing for a session that is not the offering agent’s, or for an agent not granted the Computer', async () => {
    const h = harness()
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const mine = await session()
    const theirs = await session('private', 'user:someone-else')
    const granted = { orgId: DEFAULT_ORG_ID, computerId, policy: policy(), agentAccess: granting(mine.agentId) }
    // Another agent's session, even one the desktop's owner cannot see.
    expect(await h.screenshots.put(granted, offer(theirs.sessionId, mine.agentId))).toMatchObject({ status: 'skipped' })
    // An agent the Computer does not grant, naming its own session.
    expect(await h.screenshots.put(granted, offer(theirs.sessionId, theirs.agentId))).toMatchObject({
      status: 'skipped'
    })
    // A session id the org has no record of is offered again later, never stored now.
    await expect(h.screenshots.put(granted, offer('s-made-up', mine.agentId))).rejects.toBeInstanceOf(
      ScreenshotSessionPendingError
    )
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(0)
  })

  it('applies a lowered retention to screenshots already stored', async () => {
    const h = harness()
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    await store(h, computerId, s)
    h.clock.advance(3 * DAY)
    const url = `${ORG}/sessions/${s.sessionId}/computer-screenshots/${SHA}`
    expect((await appAs(DEFAULT_OWNER_ID, h.screenshots).app.inject({ method: 'GET', url })).statusCode).toBe(200)

    // Two days now: a screenshot taken three days ago is past it.
    const lowered = await appAs(DEFAULT_OWNER_ID, h.screenshots).app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: { screenshotRetentionDays: 2 }
    })
    expect(lowered.statusCode).toBe(200)
    expect((await appAs(DEFAULT_OWNER_ID, h.screenshots).app.inject({ method: 'GET', url })).statusCode).toBe(404)
    expect(await h.screenshots.reap()).toBe(1)
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(0)
  })

  it('caps what is already stored at a lowered deployment maximum on the next sweep', async () => {
    const h = harness()
    const computerId = await register(appAs(DEFAULT_OWNER_ID))
    const s = await session()
    await store(h, computerId, s)
    h.clock.advance(10 * DAY)
    const restarted = new ComputerScreenshots(h.repo, new PgSessionRepo(prisma), h.bucket, h.clock, {
      defaultDays: 30,
      maxDays: 7
    })
    expect(await restarted.reap()).toBe(1)
    expect(await prisma.computerScreenshot.count({ where: { computerId } })).toBe(0)
  })
})
