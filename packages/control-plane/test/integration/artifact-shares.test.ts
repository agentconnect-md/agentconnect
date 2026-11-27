// Artifact share links (artifacts.md §6.3, §8.3): management under the organization, reads outside it, against real Postgres.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ArtifactInitiator } from '@agentconnect.md/protocol'
import { agentAndSession, harness, makeUser, manifestOf, newSession, publish } from '../fixtures/artifacts.js'
import { ArtifactRefusal } from '../../src/artifacts/service.js'
import { attachmentDisposition } from '../../src/file-transfer/transfer.js'
import { PgArtifactRepo, PgUserRepo } from '../../src/persistence/index.js'
import type { CronRecord } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const READ = '/api/v1/artifact-shares/read'
const FILE = '/api/v1/artifact-shares/file'
const OIDC_AUDIENCE = 'artifact-share-test'

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

let oidcServer: Server
let oidcIssuer = ''
let mintBearer: (subject: string) => Promise<string>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'share-test', use: 'sig' }
  oidcServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer: oidcIssuer, jwks_uri: `${oidcIssuer}/jwks` }))
      return
    }
    if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    oidcServer.once('error', reject)
    oidcServer.listen(0, '127.0.0.1', resolve)
  })
  oidcIssuer = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`
  mintBearer = (subject) =>
    new SignJWT({ email: `${subject}@example.test` })
      .setProtectedHeader({ alg: 'RS256', kid: 'share-test' })
      .setIssuer(oidcIssuer)
      .setAudience(OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey)
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      oidcServer.close((err) => (err ? reject(err) : resolve()))
    })
)

type Service = ReturnType<typeof harness>['service']

/** devAuth as `userId`: every request is that member, with or without a bearer. */
function appAs(userId: string, service: Service | undefined) {
  const built = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, undefined, {
    ...(service ? { artifacts: service } : {})
  })
  opened.push(built)
  return built.app
}

/** Real OIDC, so a request without a bearer is anonymous. */
function oidcApp(service: Service) {
  const built = buildHttpApp(prisma, { OIDC_ISSUER: oidcIssuer, OIDC_AUDIENCE }, undefined, undefined, {
    artifacts: service
  })
  opened.push(built)
  return built.app
}

async function member(role: 'owner' | 'collaborator' | 'viewer') {
  const sub = `share-${role}-${randomUUID()}`
  return { sub, userId: await makeUser(sub, role) }
}

const bearer = async (sub: string) => ({ authorization: `Bearer ${await mintBearer(sub)}` })

/** A private artifact owned by Dana and an `org` one she also owns, each with a ready revision 1. */
async function fixtures() {
  const h = harness()
  const dana = await member('collaborator')
  const erin = await member('collaborator')
  const priv = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana.userId}` })
  const privateArtifact = await publish(h, priv.agent, priv.sessionId)
  const org = await agentAndSession()
  const orgArtifact = await publish(h, org.agent, org.sessionId, {
    initiator: { kind: 'console', userId: dana.userId },
    manifest: manifestOf(['index.html', '<p>v1</p>'], ['img/chart.png', 'png', 'image/png'])
  })
  return { h, dana, erin, privateArtifact, orgArtifact, org }
}

const shares = (artifactId: string) => `${ORG}/artifacts/${artifactId}/shares`

describe('artifact share management', () => {
  it('lets each role create, list, change and revoke exactly as §6.3 says', async () => {
    const { h, dana, erin, privateArtifact, orgArtifact } = await fixtures()
    const as = (userId: string) => appAs(userId, h.service)
    const create = async (userId: string, artifactId: string, audience: 'public' | 'org') =>
      (await as(userId).inject({ method: 'POST', url: shares(artifactId), payload: { revision: 1, audience } }))
        .statusCode
    const list = async (userId: string, artifactId: string) =>
      (await as(userId).inject({ method: 'GET', url: shares(artifactId) })).statusCode
    const fresh = async (artifactId: string) =>
      (
        await as(dana.userId).inject({
          method: 'POST',
          url: shares(artifactId),
          payload: { revision: 1, audience: 'org' }
        })
      ).json().id as string
    const patch = async (userId: string, artifactId: string, audience: 'public' | 'org') =>
      (
        await as(userId).inject({
          method: 'PATCH',
          url: `${shares(artifactId)}/${await fresh(artifactId)}`,
          payload: { audience }
        })
      ).statusCode
    const revoke = async (userId: string, artifactId: string) =>
      (await as(userId).inject({ method: 'DELETE', url: `${shares(artifactId)}/${await fresh(artifactId)}` }))
        .statusCode

    // A private artifact: its owner does everything.
    const p = privateArtifact.artifactId
    expect(await create(dana.userId, p, 'org')).toBe(201)
    expect(await create(dana.userId, p, 'public')).toBe(201)
    expect(await list(dana.userId, p)).toBe(200)
    expect(await patch(dana.userId, p, 'public')).toBe(200)
    expect(await revoke(dana.userId, p)).toBe(204)
    // An organization owner cannot view it: no sharing or audience change, but listing and revoking for moderation.
    expect(await create(DEFAULT_OWNER_ID, p, 'org')).toBe(404)
    expect(await create(DEFAULT_OWNER_ID, p, 'public')).toBe(404)
    expect(await patch(DEFAULT_OWNER_ID, p, 'public')).toBe(404)
    expect(await patch(DEFAULT_OWNER_ID, p, 'org')).toBe(404)
    expect(await list(DEFAULT_OWNER_ID, p)).toBe(200)
    expect(await revoke(DEFAULT_OWNER_ID, p)).toBe(204)
    // Another member: it does not exist.
    expect(await create(erin.userId, p, 'org')).toBe(404)
    expect(await list(erin.userId, p)).toBe(404)
    expect(await patch(erin.userId, p, 'org')).toBe(404)
    expect(await revoke(erin.userId, p)).toBe(404)

    // An `org` artifact: a member who can view shares it with the organization and nothing more.
    const o = orgArtifact.artifactId
    expect(await create(erin.userId, o, 'org')).toBe(201)
    expect(await list(erin.userId, o)).toBe(200)
    expect(await create(erin.userId, o, 'public')).toBe(403)
    expect(await patch(erin.userId, o, 'public')).toBe(403)
    expect(await patch(erin.userId, o, 'org')).toBe(403)
    expect(await revoke(erin.userId, o)).toBe(403)
    const forbidden = await as(erin.userId).inject({
      method: 'POST',
      url: shares(o),
      payload: { revision: 1, audience: 'public' }
    })
    expect(forbidden.json()).toMatchObject({ code: 'ARTIFACT_SHARE_FORBIDDEN' })
    // An organization owner who can view it does everything.
    expect(await create(DEFAULT_OWNER_ID, o, 'public')).toBe(201)
    expect(await patch(DEFAULT_OWNER_ID, o, 'public')).toBe(200)
    expect(await revoke(DEFAULT_OWNER_ID, o)).toBe(204)
    // A viewer-role member who can view it may share it with the organization.
    const viewer = await member('viewer')
    expect(await create(viewer.userId, o, 'org')).toBe(201)
    expect(await create(viewer.userId, o, 'public')).toBe(403)
  })

  it('returns the token once, stores only its hash and lists the share without it', async () => {
    const { h, dana, orgArtifact } = await fixtures()
    const app = appAs(dana.userId, h.service)
    const created = await app.inject({
      method: 'POST',
      url: shares(orgArtifact.artifactId),
      payload: { revision: 1, audience: 'public' }
    })
    expect(created.statusCode).toBe(201)
    const body = created.json()
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body).toMatchObject({
      artifactId: orgArtifact.artifactId,
      revision: 1,
      audience: 'public',
      displayTail: `…${body.token.slice(-6)}`,
      createdBy: { userId: dana.userId, platform: null },
      revokedAt: null,
      linkPath: `/share/${body.token}`,
      link: `https://console.example.test/share/${body.token}`
    })

    const row = await prisma.artifactShare.findUniqueOrThrow({ where: { id: body.id } })
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(body.token)
    expect(row.createdByIdentity).toBe(`user:${dana.userId}`)

    const listed = await app.inject({ method: 'GET', url: shares(orgArtifact.artifactId) })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain(body.token)
    expect(listed.json().shares).toEqual([
      expect.objectContaining({ id: body.id, displayTail: body.displayTail, audience: 'public', revision: 1 })
    ])
    expect(listed.json().shares[0]).not.toHaveProperty('token')
  })

  it('refuses a revision that is not ready or does not exist', async () => {
    const { h, dana, orgArtifact, org } = await fixtures()
    await h.service.begin(DEFAULT_ORG_ID, org.agent, {
      agentId: org.agent.id,
      sessionId: org.sessionId,
      artifactId: orgArtifact.artifactId,
      manifest: manifestOf(['index.html', '<p>v2</p>']),
      idempotencyKey: `pending-${randomUUID()}`,
      network: 'cluster'
    })
    const app = appAs(dana.userId, h.service)
    const pending = await app.inject({
      method: 'POST',
      url: shares(orgArtifact.artifactId),
      payload: { revision: 2, audience: 'org' }
    })
    expect(pending.statusCode).toBe(409)
    expect(pending.json()).toMatchObject({ code: 'ARTIFACT_REVISION_NOT_READY' })
    const missing = await app.inject({
      method: 'POST',
      url: shares(orgArtifact.artifactId),
      payload: { revision: 9, audience: 'org' }
    })
    expect(missing.statusCode).toBe(404)
    expect(await prisma.artifactShare.count({ where: { artifactId: orgArtifact.artifactId } })).toBe(0)
  })

  it('answers 404 for a share of another artifact and when changing a revoked share', async () => {
    const { h, dana, privateArtifact, orgArtifact } = await fixtures()
    const app = appAs(dana.userId, h.service)
    const { id } = (
      await app.inject({
        method: 'POST',
        url: shares(orgArtifact.artifactId),
        payload: { revision: 1, audience: 'org' }
      })
    ).json()
    const elsewhere = `${shares(privateArtifact.artifactId)}/${id}`
    expect((await app.inject({ method: 'PATCH', url: elsewhere, payload: { audience: 'public' } })).statusCode).toBe(
      404
    )
    expect((await app.inject({ method: 'DELETE', url: elsewhere })).statusCode).toBe(404)
    const own = `${shares(orgArtifact.artifactId)}/${id}`
    expect((await app.inject({ method: 'DELETE', url: own })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: own })).statusCode).toBe(204)
    expect((await app.inject({ method: 'PATCH', url: own, payload: { audience: 'public' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: shares(orgArtifact.artifactId) })).json().shares).toEqual([])
  })

  it('lets the member who created a share revoke it, even once they can no longer view the artifact', async () => {
    const { h, dana, erin, orgArtifact } = await fixtures()
    const o = orgArtifact.artifactId
    const create = async (userId: string) =>
      (
        await appAs(userId, h.service).inject({
          method: 'POST',
          url: shares(o),
          payload: { revision: 1, audience: 'org' }
        })
      ).json().id as string
    const revoke = async (userId: string, id: string) =>
      (await appAs(userId, h.service).inject({ method: 'DELETE', url: `${shares(o)}/${id}` })).statusCode

    const erins = await create(erin.userId)
    const danas = await create(dana.userId)
    expect(await revoke(erin.userId, danas)).toBe(403)
    expect(await revoke(erin.userId, erins)).toBe(204)
    // Narrowed to Dana alone: Erin cannot view it any more, but her own share is still hers to revoke.
    const later = await create(erin.userId)
    await new PgArtifactRepo(prisma).setVisibility(DEFAULT_ORG_ID, o, 'private')
    expect(await revoke(erin.userId, danas)).toBe(404)
    expect(await revoke(erin.userId, later)).toBe(204)
    expect(await revoke(erin.userId, randomUUID())).toBe(404)
    const shareRows = await prisma.artifactShare.findMany({ where: { artifactId: o }, orderBy: { createdAt: 'asc' } })
    expect(shareRows.map((row) => row.revokedAt !== null)).toEqual([true, false, true])
  })

  it('removes the shares with their artifact', async () => {
    const { h, dana, orgArtifact } = await fixtures()
    const app = appAs(dana.userId, h.service)
    const { token } = (
      await app.inject({
        method: 'POST',
        url: shares(orgArtifact.artifactId),
        payload: { revision: 1, audience: 'public' }
      })
    ).json()
    await h.service.deleteArtifact(DEFAULT_ORG_ID, orgArtifact.artifactId)
    expect(await prisma.artifactShare.count({ where: { artifactId: orgArtifact.artifactId } })).toBe(0)
    const read = await app.inject({ method: 'POST', url: READ, payload: { token } })
    expect(read.statusCode).toBe(404)
    expect(read.json()).toMatchObject({ code: 'ARTIFACT_SHARE_NOT_FOUND' })
  })
})

describe('artifact share reads', () => {
  it('serves a public link to anyone, without credentials or with a bad one, and never lets it be indexed', async () => {
    const { h, dana, orgArtifact } = await fixtures()
    const { token } = (
      await appAs(dana.userId, h.service).inject({
        method: 'POST',
        url: shares(orgArtifact.artifactId),
        payload: { revision: 1, audience: 'public' }
      })
    ).json()
    const app = oidcApp(h.service)
    for (const headers of [{}, { authorization: 'Bearer not.a.jwt' }]) {
      const read = await app.inject({ method: 'POST', url: READ, payload: { token }, headers })
      expect(read.statusCode).toBe(200)
      expect(read.headers['x-robots-tag']).toBe('noindex')
      expect(read.headers['cache-control']).toBe('no-store')
      const body = read.json()
      expect(Object.keys(body).sort()).toEqual([
        'artifactId',
        'audience',
        'organization',
        'revision',
        'sharedAt',
        'title'
      ])
      expect(body).toMatchObject({
        artifactId: orgArtifact.artifactId,
        title: 'Weekly report',
        audience: 'public',
        organization: { name: expect.any(String) },
        revision: {
          number: 1,
          entry: 'index.html',
          entryMediaType: 'text/html',
          fileCount: 2,
          manifest: { entry: 'index.html' }
        }
      })
      expect(Object.keys(body.revision)).not.toContain('producedInSessionId')
    }

    const file = await app.inject({ method: 'POST', url: FILE, payload: { token, path: 'img/chart.png' } })
    expect(file.statusCode).toBe(200)
    expect(file.headers['x-robots-tag']).toBe('noindex')
    const url = new URL(file.json().url)
    expect(url.pathname).toBe(`/ac-cache/src/${DEFAULT_ORG_ID}/artifact/${orgArtifact.artifactId}/1/img/chart.png`)
    expect(url.searchParams.get('response-content-disposition')).toBe(attachmentDisposition('chart.png'))
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream')
    const outside = await app.inject({ method: 'POST', url: FILE, payload: { token, path: 'other.html' } })
    expect(outside.statusCode).toBe(404)

    for (const unknown of ['A'.repeat(43), 'short']) {
      const res = await app.inject({ method: 'POST', url: READ, payload: { token: unknown } })
      expect(res.statusCode).toBe(404)
      expect(res.headers['x-robots-tag']).toBe('noindex')
      expect(res.json()).toMatchObject({ code: 'ARTIFACT_SHARE_NOT_FOUND' })
    }
  })

  it('admits only signed-in members to an org link, keeping the link across an audience change', async () => {
    const { h, dana, orgArtifact } = await fixtures()
    const app = oidcApp(h.service)
    const created = await app.inject({
      method: 'POST',
      url: shares(orgArtifact.artifactId),
      headers: await bearer(dana.sub),
      payload: { revision: 1, audience: 'org' }
    })
    expect(created.statusCode).toBe(201)
    const { id, token } = created.json()
    const outsider = `share-outsider-${randomUUID()}`
    await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: outsider,
      email: `${outsider}@example.test`,
      emailVerified: true
    })
    const erin = await member('collaborator')

    const anonymous = await app.inject({ method: 'POST', url: READ, payload: { token } })
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.headers['x-robots-tag']).toBe('noindex')
    const stranger = await app.inject({
      method: 'POST',
      url: READ,
      payload: { token },
      headers: await bearer(outsider)
    })
    expect(stranger.statusCode).toBe(404)
    expect(stranger.json()).toMatchObject({ code: 'ARTIFACT_SHARE_MEMBERS_ONLY' })
    const strangerFile = await app.inject({
      method: 'POST',
      url: FILE,
      payload: { token, path: 'index.html' },
      headers: await bearer(outsider)
    })
    expect(strangerFile.statusCode).toBe(404)
    const read = await app.inject({ method: 'POST', url: READ, payload: { token }, headers: await bearer(erin.sub) })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toMatchObject({ audience: 'org', revision: { number: 1 } })

    // Widening keeps the link: the same token now opens without sign-in, and narrowing closes it again.
    const widened = await app.inject({
      method: 'PATCH',
      url: `${shares(orgArtifact.artifactId)}/${id}`,
      headers: await bearer(dana.sub),
      payload: { audience: 'public' }
    })
    expect(widened.statusCode).toBe(200)
    expect(widened.json()).toMatchObject({ id, audience: 'public', displayTail: created.json().displayTail })
    expect((await app.inject({ method: 'POST', url: READ, payload: { token } })).statusCode).toBe(200)
    await app.inject({
      method: 'PATCH',
      url: `${shares(orgArtifact.artifactId)}/${id}`,
      headers: await bearer(dana.sub),
      payload: { audience: 'org' }
    })
    expect((await app.inject({ method: 'POST', url: READ, payload: { token } })).statusCode).toBe(401)
  })

  it('invalidates a revoked link at once and keeps a link on its revision after a newer one', async () => {
    const { h, dana, orgArtifact, org } = await fixtures()
    const app = appAs(dana.userId, h.service)
    const make = async () =>
      (
        await app.inject({
          method: 'POST',
          url: shares(orgArtifact.artifactId),
          payload: { revision: 1, audience: 'public' }
        })
      ).json() as { id: string; token: string }
    const kept = await make()
    const gone = await make()

    await publish(h, org.agent, org.sessionId, {
      artifactId: orgArtifact.artifactId,
      manifest: manifestOf(['report.md', '# v2', 'text/markdown'])
    })
    const read = await app.inject({ method: 'POST', url: READ, payload: { token: kept.token } })
    expect(read.json().revision).toMatchObject({ number: 1, entry: 'index.html' })
    expect(
      (await app.inject({ method: 'POST', url: FILE, payload: { token: kept.token, path: 'report.md' } })).statusCode
    ).toBe(404)

    expect(
      (await app.inject({ method: 'DELETE', url: `${shares(orgArtifact.artifactId)}/${gone.id}` })).statusCode
    ).toBe(204)
    for (const [url, payload] of [
      [READ, { token: gone.token }],
      [FILE, { token: gone.token, path: 'index.html' }]
    ] as const) {
      const res = await app.inject({ method: 'POST', url, payload })
      expect(res.statusCode).toBe(410)
      expect(res.json()).toMatchObject({ code: 'ARTIFACT_SHARE_REVOKED' })
    }
    expect((await app.inject({ method: 'POST', url: READ, payload: { token: kept.token } })).statusCode).toBe(200)
  })

  it('answers every share route as not enabled on a deployment without artifacts', async () => {
    const { h, dana, orgArtifact } = await fixtures()
    const { id, token } = (
      await appAs(dana.userId, h.service).inject({
        method: 'POST',
        url: shares(orgArtifact.artifactId),
        payload: { revision: 1, audience: 'public' }
      })
    ).json()
    const off = appAs(dana.userId, undefined)
    for (const request of [
      { method: 'POST' as const, url: READ, payload: { token } },
      { method: 'POST' as const, url: FILE, payload: { token, path: 'index.html' } },
      { method: 'POST' as const, url: shares(orgArtifact.artifactId), payload: { revision: 1, audience: 'org' } },
      { method: 'GET' as const, url: shares(orgArtifact.artifactId) },
      { method: 'PATCH' as const, url: `${shares(orgArtifact.artifactId)}/${id}`, payload: { audience: 'org' } },
      { method: 'DELETE' as const, url: `${shares(orgArtifact.artifactId)}/${id}` }
    ]) {
      const res = await off.inject(request)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'ARTIFACTS_NOT_ENABLED' })
    }
  })
})

describe('agent share tools', () => {
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ArtifactRefusal)
    return err as ArtifactRefusal
  }
  const console_ = (userId: string): ArtifactInitiator => ({ kind: 'console', userId })

  it('shares and unshares with the initiating member’s authority, returning a link that opens', async () => {
    const { h, dana, erin, orgArtifact, org } = await fixtures()
    const artifactId = orgArtifact.artifactId
    const base = { agentId: org.agent.id, sessionId: org.sessionId, artifactId }

    // Dana owns the artifact, so she may share it publicly; the latest ready revision is the default.
    const shared = await h.service.share(DEFAULT_ORG_ID, {
      ...base,
      audience: 'public',
      initiator: console_(dana.userId)
    })
    expect(shared).toMatchObject({
      artifactId,
      revision: 1,
      audience: 'public',
      linkPath: expect.stringMatching(/^\/share\//)
    })
    expect(shared.link).toBe(`https://console.example.test${shared.linkPath}`)
    expect(shared.displayTail).toBe(`…${shared.linkPath.slice(-6)}`)
    const row = await prisma.artifactShare.findUniqueOrThrow({ where: { id: shared.shareId } })
    expect(row.createdByIdentity).toBe(`user:${dana.userId}`)
    const token = shared.linkPath.slice('/share/'.length)
    const anyone = oidcApp(h.service)
    expect((await anyone.inject({ method: 'POST', url: READ, payload: { token } })).statusCode).toBe(200)

    // Erin can view it: an `org` share, never a public one.
    const erins = await h.service.share(DEFAULT_ORG_ID, { ...base, audience: 'org', initiator: console_(erin.userId) })
    expect(
      (
        await refusal(
          h.service.share(DEFAULT_ORG_ID, { ...base, audience: 'public', initiator: console_(erin.userId) })
        )
      ).reason
    ).toBe('share-forbidden')

    // The agent lists the active shares, newest first.
    const listed = (
      await h.service.list(DEFAULT_ORG_ID, { agentId: org.agent.id, sessionId: org.sessionId })
    ).artifacts.find((a) => a.artifactId === artifactId)
    expect(listed?.shares?.map((s) => s.shareId)).toEqual([erins.shareId, shared.shareId])
    expect(JSON.stringify(listed)).not.toContain(token)

    // Erin revokes her own share but not Dana's; Dana, the owner, revokes hers.
    const unshare = (shareId: string, initiator: ArtifactInitiator) =>
      h.service.unshare(DEFAULT_ORG_ID, { ...base, shareId, initiator })
    expect((await refusal(unshare(shared.shareId, console_(erin.userId)))).reason).toBe('share-forbidden')
    expect(await unshare(erins.shareId, console_(erin.userId))).toMatchObject({
      shareId: erins.shareId,
      audience: 'org'
    })
    const revoked = await unshare(shared.shareId, console_(dana.userId))
    expect(revoked).toMatchObject({
      shareId: shared.shareId,
      revision: 1,
      audience: 'public',
      revokedAt: expect.any(String)
    })
    // Repeating it answers the first revocation.
    expect((await unshare(shared.shareId, console_(dana.userId))).revokedAt).toBe(revoked.revokedAt)
    expect((await anyone.inject({ method: 'POST', url: READ, payload: { token } })).statusCode).toBe(410)
    expect((await refusal(unshare(randomUUID(), console_(dana.userId)))).reason).toBe('share-not-found')
  })

  it('refuses a turn without a member: a stranger, an unlinked sender, no initiator, or a trigger without a member creator', async () => {
    const { h, dana, orgArtifact, org } = await fixtures()
    const base = {
      agentId: org.agent.id,
      sessionId: org.sessionId,
      artifactId: orgArtifact.artifactId,
      audience: 'org' as const
    }
    const { shareId } = await h.service.share(DEFAULT_ORG_ID, { ...base, initiator: console_(dana.userId) })
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
      expect((await refusal(h.service.share(DEFAULT_ORG_ID, { ...base, ...extra }))).reason).toBe('no-member-authority')
      const { audience: _audience, ...unshareBase } = base
      expect((await refusal(h.service.unshare(DEFAULT_ORG_ID, { ...unshareBase, shareId, ...extra }))).reason).toBe(
        'no-member-authority'
      )
    }
    expect(await prisma.artifactShare.count({ where: { artifactId: orgArtifact.artifactId } })).toBe(1)

    // A cron acts as its creator when that creator is a member, and is refused when it has none.
    const withCreator = randomUUID()
    const orphaned = randomUUID()
    const crons = harness([
      { id: withCreator, orgId: DEFAULT_ORG_ID, targetChannel: null, createdByUserId: dana.userId },
      { id: orphaned, orgId: DEFAULT_ORG_ID, targetChannel: null, createdByUserId: null }
    ] as unknown as CronRecord[])
    const byCron = await crons.service.share(DEFAULT_ORG_ID, {
      ...base,
      audience: 'public',
      initiator: { kind: 'cron', cronId: withCreator }
    })
    expect((await prisma.artifactShare.findUniqueOrThrow({ where: { id: byCron.shareId } })).createdByIdentity).toBe(
      `user:${dana.userId}`
    )
    expect(
      (await refusal(crons.service.share(DEFAULT_ORG_ID, { ...base, initiator: { kind: 'cron', cronId: orphaned } })))
        .reason
    ).toBe('no-member-authority')
  })

  it('reaches only what the agent produced and the session may see, and only a ready revision', async () => {
    const { h, dana, erin, privateArtifact, orgArtifact, org } = await fixtures()
    const as = { initiator: console_(dana.userId), audience: 'org' as const }

    // Another agent's session reaches the org artifact but did not produce it.
    const other = await agentAndSession()
    expect(
      (
        await refusal(
          h.service.share(DEFAULT_ORG_ID, {
            agentId: other.agentId,
            sessionId: other.sessionId,
            artifactId: orgArtifact.artifactId,
            ...as
          })
        )
      ).reason
    ).toBe('not-producer')

    // Dana's private artifact is absent from Erin's private session of its own agent.
    const priv = await prisma.artifactRevision.findFirstOrThrow({ where: { artifactId: privateArtifact.artifactId } })
    const erinPrivate = await newSession(priv.producedByAgentId, {
      visibility: 'private',
      ownerIdentity: `user:${erin.userId}`
    })
    expect(
      (
        await refusal(
          h.service.share(DEFAULT_ORG_ID, {
            agentId: priv.producedByAgentId,
            sessionId: erinPrivate,
            artifactId: privateArtifact.artifactId,
            ...as
          })
        )
      ).reason
    ).toBe('not-found')

    // A pending revision is refused until it completes; one that does not exist is not found.
    await h.service.begin(DEFAULT_ORG_ID, org.agent, {
      agentId: org.agent.id,
      sessionId: org.sessionId,
      artifactId: orgArtifact.artifactId,
      manifest: manifestOf(['index.html', '<p>v2</p>']),
      idempotencyKey: `pending-${randomUUID()}`,
      network: 'cluster'
    })
    const base = { agentId: org.agent.id, sessionId: org.sessionId, artifactId: orgArtifact.artifactId, ...as }
    expect((await refusal(h.service.share(DEFAULT_ORG_ID, { ...base, revision: 2 }))).reason).toBe('revision-not-ready')
    expect((await refusal(h.service.share(DEFAULT_ORG_ID, { ...base, revision: 9 }))).reason).toBe('not-found')
    expect((await h.service.share(DEFAULT_ORG_ID, base)).revision).toBe(1)
  })
})
