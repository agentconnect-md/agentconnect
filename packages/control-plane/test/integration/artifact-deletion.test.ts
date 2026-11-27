// Artifact deletion (artifacts.md D13, §5.6, §6.3, §7.3, §10.1): rows go at once, objects right after and once more later.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArtifactInitiator } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { agentAndSession, harness, makeUser, manifestOf, newSession, publish, T0 } from '../fixtures/artifacts.js'
import { ArtifactRefusal } from '../../src/artifacts/service.js'
import { PgArtifactRepo } from '../../src/persistence/index.js'
import type { CronRecord } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const READ = '/api/v1/artifact-shares/read'
const FILE = '/api/v1/artifact-shares/file'
// 900 s of upload URL lifetime plus the 300 s grace the harness's service adds.
const PURGE_DELAY_MS = 1_200_000

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

type Harness = ReturnType<typeof harness>

function appAs(userId: string, h: Harness | undefined) {
  const built = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, undefined, {
    ...(h ? { artifacts: h.service } : {})
  })
  opened.push(built)
  return built.app
}

const member = async (role: 'owner' | 'collaborator' | 'viewer') => {
  const sub = `delete-${role}-${randomUUID()}`
  return { sub, userId: await makeUser(sub, role) }
}

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ArtifactRefusal)
  return err as ArtifactRefusal
}

const console_ = (userId: string): ArtifactInitiator => ({ kind: 'console', userId })
const keysOf = (h: Harness, artifactId: string) => [...h.objects.keys()].filter((k) => k.includes(`/${artifactId}/`))

/** A private artifact owned by Dana and an `org` one she also owns, each with a ready revision 1. */
async function fixtures(h: Harness = harness()) {
  const dana = await member('collaborator')
  const erin = await member('collaborator')
  const priv = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana.userId}` })
  const privateArtifact = await publish(h, priv.agent, priv.sessionId)
  const org = await agentAndSession()
  const orgArtifact = await publish(h, org.agent, org.sessionId, {
    initiator: console_(dana.userId),
    manifest: manifestOf(['index.html', '<p>v1</p>'], ['img/chart.png', 'png', 'image/png'])
  })
  return { h, dana, erin, priv, privateArtifact, org, orgArtifact }
}

describe('deleting an artifact from the console', () => {
  it('lets the owner and organization owners delete, even without viewing, and refuses everyone else', async () => {
    const { h, dana, erin, privateArtifact, orgArtifact } = await fixtures()
    const del = async (userId: string, artifactId: string) =>
      await appAs(userId, h).inject({ method: 'DELETE', url: `${ORG}/artifacts/${artifactId}` })

    // Erin can view the org artifact but owns neither: 403 there, and the private one does not exist for her.
    const forbidden = await del(erin.userId, orgArtifact.artifactId)
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toMatchObject({ code: 'ARTIFACT_DELETE_FORBIDDEN' })
    expect((await del(erin.userId, privateArtifact.artifactId)).statusCode).toBe(404)
    const viewer = await member('viewer')
    expect((await del(viewer.userId, orgArtifact.artifactId)).statusCode).toBe(403)

    // An organization owner deletes Dana's private artifact without being able to view it.
    expect(
      (
        await appAs(DEFAULT_OWNER_ID, h).inject({
          method: 'GET',
          url: `${ORG}/artifacts/${privateArtifact.artifactId}`
        })
      ).statusCode
    ).toBe(404)
    expect((await del(DEFAULT_OWNER_ID, privateArtifact.artifactId)).statusCode).toBe(204)
    // Dana, the owner, deletes hers; a second delete and an unknown id are not found.
    expect((await del(dana.userId, orgArtifact.artifactId)).statusCode).toBe(204)
    expect((await del(dana.userId, orgArtifact.artifactId)).statusCode).toBe(404)
    expect((await del(dana.userId, randomUUID())).statusCode).toBe(404)
    expect(
      await prisma.artifact.count({ where: { id: { in: [privateArtifact.artifactId, orgArtifact.artifactId] } } })
    ).toBe(0)

    // Without artifacts on the deployment, the route says so.
    const off = await appAs(dana.userId, undefined).inject({
      method: 'DELETE',
      url: `${ORG}/artifacts/${randomUUID()}`
    })
    expect(off.statusCode).toBe(409)
    expect(off.json()).toMatchObject({ code: 'ARTIFACTS_NOT_ENABLED' })
  })

  it('takes the artifact out of every list, read and share link at once', async () => {
    const { h, dana, org, orgArtifact } = await fixtures()
    const app = appAs(dana.userId, h)
    const id = orgArtifact.artifactId
    const { token } = (
      await app.inject({
        method: 'POST',
        url: `${ORG}/artifacts/${id}/shares`,
        payload: { revision: 1, audience: 'public' }
      })
    ).json()
    expect((await app.inject({ method: 'POST', url: READ, payload: { token } })).statusCode).toBe(200)

    expect((await app.inject({ method: 'DELETE', url: `${ORG}/artifacts/${id}` })).statusCode).toBe(204)

    for (const url of [
      `${ORG}/artifacts/${id}`,
      `${ORG}/artifacts/${id}/revisions/1`,
      `${ORG}/artifacts/${id}/revisions/1/file?path=index.html`,
      `${ORG}/artifacts/${id}/shares`
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
    }
    const sessionList = await app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${encodeURIComponent(org.sessionId)}/artifacts`
    })
    expect(sessionList.statusCode).toBe(200)
    expect(sessionList.json().artifacts).toEqual([])
    const agentList = await h.service.list(DEFAULT_ORG_ID, { agentId: org.agentId, sessionId: org.sessionId })
    expect(agentList.artifacts.map((a) => a.artifactId)).not.toContain(id)
    expect(
      (
        await refusal(
          h.service.fetch(DEFAULT_ORG_ID, {
            agentId: org.agentId,
            sessionId: org.sessionId,
            artifactId: id,
            network: 'cluster'
          })
        )
      ).reason
    ).toBe('not-found')
    // A deleted artifact's share link reads as one that never existed.
    for (const [url, payload] of [
      [READ, { token }],
      [FILE, { token, path: 'index.html' }]
    ] as const) {
      const res = await app.inject({ method: 'POST', url, payload })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ code: 'ARTIFACT_SHARE_NOT_FOUND' })
    }
    expect(await prisma.artifactShare.count({ where: { artifactId: id } })).toBe(0)
    expect(await prisma.artifactRevision.count({ where: { artifactId: id } })).toBe(0)
  })
})

describe('deleting the stored files', () => {
  it('deletes every object right after the rows, and once more after upload URLs have expired', async () => {
    const { h, dana, org, orgArtifact } = await fixtures()
    const id = orgArtifact.artifactId
    await publish(h, org.agent, org.sessionId, {
      artifactId: id,
      manifest: manifestOf(['report.md', '# v2', 'text/markdown'])
    })
    expect(keysOf(h, id)).toHaveLength(3)

    expect((await appAs(dana.userId, h).inject({ method: 'DELETE', url: `${ORG}/artifacts/${id}` })).statusCode).toBe(
      204
    )
    expect(keysOf(h, id)).toEqual([])
    expect([...h.deletes].sort()).toEqual([
      `src/${DEFAULT_ORG_ID}/artifact/${id}/1/img/chart.png`,
      `src/${DEFAULT_ORG_ID}/artifact/${id}/1/index.html`,
      `src/${DEFAULT_ORG_ID}/artifact/${id}/2/report.md`
    ])
    // The record stays until the sweep after purgeAfter: objects first, then the record.
    const record = await prisma.artifactDeletion.findUniqueOrThrow({ where: { id } })
    expect(record).toMatchObject({
      deletedAt: new Date(T0),
      purgeAfter: new Date(T0 + PURGE_DELAY_MS),
      sweptAt: new Date(T0)
    })
    expect(await h.service.reap()).toBe(0)

    // A PUT signed before the deletion lands late; the sweep after purgeAfter removes it and drops the record.
    const late = `src/${DEFAULT_ORG_ID}/artifact/${id}/2/report.md`
    h.objects.set(late, { exists: true, contentLength: 4 })
    h.clock.now = T0 + PURGE_DELAY_MS - 1
    expect(await h.service.reap()).toBe(0)
    expect(h.objects.has(late)).toBe(true)
    h.clock.now = T0 + PURGE_DELAY_MS
    expect(await h.service.reap()).toBe(1)
    expect(h.objects.has(late)).toBe(false)
    expect(await prisma.artifactDeletion.count({ where: { id } })).toBe(0)
  })

  it('keeps the record while the bucket refuses deletes and finishes on a later pass', async () => {
    const { h, dana, orgArtifact } = await fixtures()
    const id = orgArtifact.artifactId
    h.bucket.failDeletes = true
    // The rows go regardless: deletion is immediate for people even while the bucket is down.
    expect((await appAs(dana.userId, h).inject({ method: 'DELETE', url: `${ORG}/artifacts/${id}` })).statusCode).toBe(
      204
    )
    expect(await prisma.artifact.count({ where: { id } })).toBe(0)
    expect(keysOf(h, id)).toHaveLength(2)
    expect((await prisma.artifactDeletion.findUniqueOrThrow({ where: { id } })).sweptAt).toBeNull()
    await expect(h.service.reap()).rejects.toThrow('bucket unavailable')
    expect(await prisma.artifactDeletion.count({ where: { id } })).toBe(1)

    h.bucket.failDeletes = false
    h.clock.now = T0 + 60_000
    expect(await h.service.reap()).toBe(0)
    expect(keysOf(h, id)).toEqual([])
    expect((await prisma.artifactDeletion.findUniqueOrThrow({ where: { id } })).sweptAt).toEqual(new Date(T0 + 60_000))
    h.clock.now = T0 + PURGE_DELAY_MS
    expect(await h.service.reap()).toBe(1)
    expect(await prisma.artifactDeletion.count()).toBe(0)
  })
})

describe('a publish racing a deletion', () => {
  it('refuses a publish still uploading at completion, and sweeps the keys it was signed for', async () => {
    const { h, dana, org, orgArtifact } = await fixtures()
    const id = orgArtifact.artifactId
    const begun = await h.service.begin(DEFAULT_ORG_ID, org.agent, {
      agentId: org.agentId,
      sessionId: org.sessionId,
      artifactId: id,
      manifest: manifestOf(['late.html', '<p>late</p>']),
      idempotencyKey: `inflight-${randomUUID()}`,
      network: 'cluster'
    })
    if (begun.state !== 'pending') throw new Error('expected a pending revision')
    h.upload(begun)
    expect((await appAs(dana.userId, h).inject({ method: 'DELETE', url: `${ORG}/artifacts/${id}` })).statusCode).toBe(
      204
    )
    expect(h.deletes).toContain(`src/${DEFAULT_ORG_ID}/artifact/${id}/2/late.html`)
    const refused = await refusal(
      h.service.complete(DEFAULT_ORG_ID, { agentId: org.agentId, artifactId: id, revision: 2 })
    )
    expect(refused.reason).toBe('not-found')
    // A later append is refused before any URL is signed.
    const again = await refusal(
      h.service.begin(DEFAULT_ORG_ID, org.agent, {
        agentId: org.agentId,
        sessionId: org.sessionId,
        artifactId: id,
        manifest: manifestOf(['late.html', '<p>later</p>']),
        idempotencyKey: `after-${randomUUID()}`,
        network: 'cluster'
      })
    )
    expect(again.reason).toBe('not-found')
  })

  it('sends no upload URL when the deletion lands while the append is being signed', async () => {
    const repo = new PgArtifactRepo(prisma)
    const race: { artifactId?: string } = {}
    // The deletion commits right after the append records its revision, before begin returns.
    const racing = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'appendRevision') {
          return async (...args: Parameters<PgArtifactRepo['appendRevision']>) => {
            const appended = await target.appendRevision(...args)
            if (race.artifactId) {
              await target.deleteRecording(DEFAULT_ORG_ID, race.artifactId, {
                deletedAt: new Date(T0),
                purgeAfter: new Date(T0 + PURGE_DELAY_MS)
              })
            }
            return appended
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      }
    })
    const h = harness([], racing)
    const { org, orgArtifact } = await fixtures(h)
    race.artifactId = orgArtifact.artifactId
    const refused = await refusal(
      h.service.begin(DEFAULT_ORG_ID, org.agent, {
        agentId: org.agentId,
        sessionId: org.sessionId,
        artifactId: orgArtifact.artifactId,
        manifest: manifestOf(['index.html', '<p>v2</p>']),
        idempotencyKey: `race-${randomUUID()}`,
        network: 'cluster'
      })
    )
    expect(refused.reason).toBe('not-found')
    const record = await prisma.artifactDeletion.findUniqueOrThrow({ where: { id: orgArtifact.artifactId } })
    expect(record.objectKeys).toContain(`src/${DEFAULT_ORG_ID}/artifact/${orgArtifact.artifactId}/2/index.html`)
  })
})

describe('the agent’s deleteArtifact', () => {
  it('deletes with the initiating member’s authority: the owner or an organization owner', async () => {
    const { h, dana, erin, org, orgArtifact } = await fixtures()
    const base = { agentId: org.agentId, sessionId: org.sessionId, artifactId: orgArtifact.artifactId }
    expect(
      (await refusal(h.service.delete(DEFAULT_ORG_ID, { ...base, initiator: console_(erin.userId) }))).reason
    ).toBe('delete-forbidden')
    expect(await prisma.artifact.count({ where: { id: base.artifactId } })).toBe(1)
    const deleted = await h.service.delete(DEFAULT_ORG_ID, { ...base, initiator: console_(dana.userId) })
    expect(deleted).toEqual({
      artifactId: base.artifactId,
      title: 'Weekly report',
      deletedAt: new Date(T0).toISOString()
    })
    expect(await prisma.artifact.count({ where: { id: base.artifactId } })).toBe(0)
    expect(keysOf(h, base.artifactId)).toEqual([])
    expect(
      (await refusal(h.service.delete(DEFAULT_ORG_ID, { ...base, initiator: console_(dana.userId) }))).reason
    ).toBe('not-found')

    // An organization owner deletes an artifact owned by someone else that their session reaches.
    const another = await publish(h, org.agent, org.sessionId, { initiator: console_(dana.userId) })
    await h.service.delete(DEFAULT_ORG_ID, {
      ...base,
      artifactId: another.artifactId,
      initiator: console_(DEFAULT_OWNER_ID)
    })
    expect(await prisma.artifact.count({ where: { id: another.artifactId } })).toBe(0)
  })

  it('refuses a turn without a member, an artifact another agent produced, and one the session cannot reach', async () => {
    const { h, dana, erin, priv, privateArtifact, org, orgArtifact } = await fixtures()
    const base = { agentId: org.agentId, sessionId: org.sessionId, artifactId: orgArtifact.artifactId }
    const suspended = await member('collaborator')
    await prisma.membership.updateMany({ where: { userId: suspended.userId }, data: { suspendedAt: new Date() } })
    for (const initiator of [
      console_(randomUUID()),
      console_(suspended.userId),
      { kind: 'chat', integrationId: randomUUID(), memberId: 'U-unlinked' } as const,
      { kind: 'hook', hookId: randomUUID() } as const,
      undefined
    ]) {
      const extra = initiator ? { initiator } : {}
      expect((await refusal(h.service.delete(DEFAULT_ORG_ID, { ...base, ...extra }))).reason).toBe(
        'no-member-authority'
      )
    }
    // A cron without a member creator has no authority; one whose creator owns the artifact does.
    const orphaned = randomUUID()
    const withCreator = randomUUID()
    const crons = harness([
      { id: orphaned, orgId: DEFAULT_ORG_ID, targetChannel: null, createdByUserId: null },
      { id: withCreator, orgId: DEFAULT_ORG_ID, targetChannel: null, createdByUserId: dana.userId }
    ] as unknown as CronRecord[])
    expect(
      (await refusal(crons.service.delete(DEFAULT_ORG_ID, { ...base, initiator: { kind: 'cron', cronId: orphaned } })))
        .reason
    ).toBe('no-member-authority')

    // Another agent's session reaches the org artifact but did not produce it.
    const other = await agentAndSession()
    expect(
      (
        await refusal(
          h.service.delete(DEFAULT_ORG_ID, {
            ...base,
            agentId: other.agentId,
            sessionId: other.sessionId,
            initiator: console_(dana.userId)
          })
        )
      ).reason
    ).toBe('not-producer')

    // Dana's private artifact is absent from Erin's private session of the same agent, even for an organization owner's turn.
    const erinPrivate = await newSession(priv.agentId, { visibility: 'private', ownerIdentity: `user:${erin.userId}` })
    expect(
      (
        await refusal(
          h.service.delete(DEFAULT_ORG_ID, {
            agentId: priv.agentId,
            sessionId: erinPrivate,
            artifactId: privateArtifact.artifactId,
            initiator: console_(DEFAULT_OWNER_ID)
          })
        )
      ).reason
    ).toBe('not-found')
    expect(
      await prisma.artifact.count({ where: { id: { in: [orgArtifact.artifactId, privateArtifact.artifactId] } } })
    ).toBe(2)

    const byCron = await crons.service.delete(DEFAULT_ORG_ID, {
      ...base,
      initiator: { kind: 'cron', cronId: withCreator }
    })
    expect(byCron.artifactId).toBe(orgArtifact.artifactId)
  })
})
