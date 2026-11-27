// Artifacts over the wire and the read routes (artifacts.md §5.3, §6.1, §7.2, §8.1), against real Postgres and a signing bucket.
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArtifactInitiator, ArtifactManifest, ArtifactPublishBeginOk } from '@agentconnect.md/protocol'
import type { SourceCacheObjectHead } from '@agentconnect.md/object-store'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { ArtifactRefusal, createArtifactService } from '../../src/artifacts/service.js'
import { FileTransferConfigSchema } from '../../src/file-transfer/config.js'
import { attachmentDisposition, createFileTransfer } from '../../src/file-transfer/transfer.js'
import { PgAgentRepo, PgArtifactRepo, PgOrgRepo, PgSessionRepo, PgUserRepo } from '../../src/persistence/index.js'
import type { AgentRecord, CronRecord, OrgMemberRole } from '../../src/persistence/ports.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const T0 = Date.parse('2026-11-25T10:00:00.000Z')

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

const hex = (text: string) => createHash('sha256').update(text).digest('hex')
const manifestOf = (...files: Array<[string, string, string?]>): ArtifactManifest => ({
  entry: files[0]![0],
  files: files.map(([path, body, mediaType]) => ({
    path,
    sha256: hex(body),
    bytes: Buffer.byteLength(body),
    mediaType: mediaType ?? 'text/html'
  }))
})

// A real signer over an in-memory bucket: the test "uploads" a signed PUT by recording its signed length and checksum.
function harness(crons: CronRecord[] = []) {
  const objects = new Map<string, SourceCacheObjectHead>()
  const transfer = createFileTransfer({
    config: FileTransferConfigSchema.parse({
      version: 1,
      endpoint: 'https://store.internal.example.test',
      publicEndpoint: 'https://store.example.test',
      region: 'us-east-1',
      bucket: 'ac-cache',
      forcePathStyle: true,
      credentials: { source: 'static', dir: '/creds', accessKeyIdKey: 'id', secretAccessKeyKey: 'secret' }
    }),
    credentials: { source: 'static', get: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }) },
    objects: {
      head: async (key) => objects.get(key) ?? { exists: false },
      delete: async (key) => void objects.delete(key),
      createMultipartUpload: async () => 'mp'
    },
    enabled: () => true,
    now: () => T0
  })
  const service = createArtifactService({
    transfer,
    artifacts: new PgArtifactRepo(prisma),
    sessions: new PgSessionRepo(prisma),
    users: new PgUserRepo(prisma),
    agents: new PgAgentRepo(prisma),
    crons: { listForAgent: async () => crons },
    hooks: { get: async () => null },
    orgs: new PgOrgRepo(prisma),
    webAppUrl: 'https://console.example.test'
  })
  const upload = (ok: ArtifactPublishBeginOk) => {
    if (ok.state !== 'pending') throw new Error('nothing to upload')
    for (const put of ok.uploads) {
      const key = decodeURIComponent(new URL(put.url).pathname).slice('/ac-cache/'.length)
      objects.set(key, {
        exists: true,
        contentLength: Number(put.headers['content-length']),
        checksumSha256: put.headers['x-amz-checksum-sha256']!
      })
    }
  }
  return { service, objects, upload }
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@example.test`
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function agentAndSession(opts: { visibility?: 'org' | 'private' | 'editors'; ownerIdentity?: string } = {}) {
  const daemonId = await seedDaemon(prisma, randomUUID())
  const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
  const sessionId = await newSession(agentId, opts)
  const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId))) as AgentRecord
  return { agent, agentId, sessionId }
}

const newSession = (
  agentId: string,
  opts: { visibility?: 'org' | 'private' | 'editors'; ownerIdentity?: string } = {}
) =>
  seedSessionMeta(prisma, `webchat:${randomUUID()}`, agentId, {
    visibility: opts.visibility ?? 'org',
    ...(opts.ownerIdentity ? { ownerIdentity: opts.ownerIdentity } : {})
  })

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ArtifactRefusal)
  return err as ArtifactRefusal
}

/** Begin, upload and complete one revision. */
async function publish(
  h: ReturnType<typeof harness>,
  agent: AgentRecord,
  sessionId: string,
  extra: { artifactId?: string; initiator?: ArtifactInitiator; manifest?: ArtifactManifest } = {}
) {
  const begun = await h.service.begin(DEFAULT_ORG_ID, agent, {
    agentId: agent.id,
    sessionId,
    title: 'Weekly report',
    manifest: extra.manifest ?? manifestOf(['index.html', '<p>hi</p>']),
    idempotencyKey: `key-${randomUUID()}`,
    network: 'cluster',
    ...(extra.artifactId ? { artifactId: extra.artifactId } : {}),
    ...(extra.initiator ? { initiator: extra.initiator } : {})
  })
  h.upload(begun)
  if (begun.state !== 'pending') throw new Error('expected a pending revision')
  return await h.service.complete(DEFAULT_ORG_ID, {
    agentId: agent.id,
    artifactId: begun.artifactId,
    revision: begun.revision
  })
}

describe('artifact publishing', () => {
  it('signs one live-tagged PUT per file, refuses complete until every object holds its bytes, then reports the link', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const manifest = manifestOf(
      ['report.pdf', '%PDF', 'application/pdf'],
      ['report.docx', 'docx', 'application/octet-stream']
    )
    const begun = await h.service.begin(DEFAULT_ORG_ID, agent, {
      agentId: agent.id,
      sessionId,
      title: 'Q3 report',
      manifest,
      idempotencyKey: 'publish-q3-0001',
      network: 'cluster'
    })
    if (begun.state !== 'pending') throw new Error('expected pending')
    expect(begun.revision).toBe(1)
    expect(begun.uploads.map((u) => u.path)).toEqual(['report.pdf', 'report.docx'])
    const [pdf] = begun.uploads
    expect(new URL(pdf!.url).pathname).toBe(`/ac-cache/src/${DEFAULT_ORG_ID}/artifact/${begun.artifactId}/1/report.pdf`)
    expect(pdf!.headers).toMatchObject({ 'x-amz-tagging': 'ac-cache=live', 'content-length': '4' })

    const early = await refusal(
      h.service.complete(DEFAULT_ORG_ID, { agentId: agent.id, artifactId: begun.artifactId, revision: 1 })
    )
    expect(early.reason).toBe('incomplete')
    expect(early.details).toEqual({ paths: ['report.pdf', 'report.docx'] })

    h.upload(begun)
    // A store copy whose length differs from the manifest is not the declared file.
    const docxKey = `src/${DEFAULT_ORG_ID}/artifact/${begun.artifactId}/1/report.docx`
    h.objects.set(docxKey, { exists: true, contentLength: 99 })
    expect(
      (
        await refusal(
          h.service.complete(DEFAULT_ORG_ID, { agentId: agent.id, artifactId: begun.artifactId, revision: 1 })
        )
      ).details
    ).toEqual({ paths: ['report.docx'] })
    h.upload(begun)

    const done = await h.service.complete(DEFAULT_ORG_ID, {
      agentId: agent.id,
      artifactId: begun.artifactId,
      revision: 1
    })
    expect(done).toMatchObject({
      artifactId: begun.artifactId,
      revision: 1,
      title: 'Q3 report',
      linkPath: expect.stringMatching(new RegExp(`/artifacts/${begun.artifactId}\\?revision=1$`)),
      link: expect.stringMatching(/^https:\/\/console\.example\.test\//),
      audience: { visibility: 'org', owned: false }
    })
    // A repeated complete answers the same, and only the producing agent may complete.
    expect(
      await h.service.complete(DEFAULT_ORG_ID, { agentId: agent.id, artifactId: begun.artifactId, revision: 1 })
    ).toEqual(done)
    const other = await agentAndSession()
    expect(
      (
        await refusal(
          h.service.complete(DEFAULT_ORG_ID, { agentId: other.agentId, artifactId: begun.artifactId, revision: 1 })
        )
      ).reason
    ).toBe('not-found')
  })

  it('replays a retried begin: the same revision re-signed while pending, the ready result once complete, a conflict for another manifest', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const req = {
      agentId: agent.id,
      sessionId,
      title: 'Report',
      manifest: manifestOf(['index.html', '<p>v1</p>']),
      idempotencyKey: 'retry-key-0001',
      network: 'cluster' as const
    }
    const first = await h.service.begin(DEFAULT_ORG_ID, agent, req)
    const again = await h.service.begin(DEFAULT_ORG_ID, agent, req)
    expect(again).toMatchObject({ state: 'pending', artifactId: first.artifactId, revision: 1 })
    h.upload(first)
    await h.service.complete(DEFAULT_ORG_ID, { agentId: agent.id, artifactId: first.artifactId, revision: 1 })
    expect(await h.service.begin(DEFAULT_ORG_ID, agent, req)).toMatchObject({
      state: 'ready',
      artifactId: first.artifactId,
      revision: 1
    })
    const changed = { ...req, manifest: manifestOf(['index.html', '<p>v2</p>']) }
    expect((await refusal(h.service.begin(DEFAULT_ORG_ID, agent, changed))).reason).toBe('idempotency-conflict')
    expect(await prisma.artifactRevision.count({ where: { artifactId: first.artifactId } })).toBe(1)
  })

  it('copies the owner and audience from the session and the initiator', async () => {
    const h = harness()
    const dana = await makeUser(`art-dana-${randomUUID()}`, 'collaborator')
    const priv = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana}` })
    expect((await publish(h, priv.agent, priv.sessionId)).audience).toEqual({ visibility: 'private', owned: true })

    const org = await agentAndSession()
    const byMember = await publish(h, org.agent, org.sessionId, { initiator: { kind: 'console', userId: dana } })
    expect(byMember.audience).toEqual({ visibility: 'org', owned: true })
    const row = await new PgArtifactRepo(prisma).get(DEFAULT_ORG_ID, byMember.artifactId)
    expect(row?.ownerIdentity).toBe(`user:${dana}`)
    const rev = await new PgArtifactRepo(prisma).getRevision(DEFAULT_ORG_ID, byMember.artifactId, 1)
    expect(rev?.initiatedBy).toBe(`user:${dana}`)
    // A console id that is not a member is provenance only: no owner.
    const byStranger = await publish(h, org.agent, org.sessionId, {
      initiator: { kind: 'console', userId: randomUUID() }
    })
    expect(byStranger.audience).toEqual({ visibility: 'org', owned: false })

    const editors = await agentAndSession({ visibility: 'editors', ownerIdentity: 'slack:T1:U1' })
    expect((await publish(h, editors.agent, editors.sessionId)).audience).toEqual({
      visibility: 'editors',
      owned: false
    })
  })

  it('makes a headless cron’s artifact private to its creator, and an unknown trigger’s to organization owners', async () => {
    const creator = await makeUser(`art-cron-${randomUUID()}`, 'collaborator')
    const cronId = randomUUID()
    const h = harness([
      { id: cronId, orgId: DEFAULT_ORG_ID, targetChannel: null, createdByUserId: creator } as unknown as CronRecord
    ])
    const { agent, sessionId } = await agentAndSession()
    const headless = await publish(h, agent, sessionId, { initiator: { kind: 'cron', cronId } })
    expect(headless.audience).toEqual({ visibility: 'private', owned: true })
    expect((await new PgArtifactRepo(prisma).get(DEFAULT_ORG_ID, headless.artifactId))?.ownerIdentity).toBe(
      `user:${creator}`
    )
    const unknown = await publish(h, agent, sessionId, { initiator: { kind: 'hook', hookId: randomUUID() } })
    expect(unknown.audience).toEqual({ visibility: 'private', owned: false })
  })

  it('appends only for the agent that produced revision 1 and only where the session reaches the artifact', async () => {
    const h = harness()
    const dana = await makeUser(`art-own-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`art-other-${randomUUID()}`, 'collaborator')
    const { agent, agentId, sessionId } = await agentAndSession()
    const first = await publish(h, agent, sessionId)

    // A later org session of the same agent appends revision 2.
    const later = await newSession(agentId)
    expect((await publish(h, agent, later, { artifactId: first.artifactId })).revision).toBe(2)
    // D19: a private session reaches what its owner can view, so its owner may ask for revision 3.
    const danaPrivate = await newSession(agentId, { visibility: 'private', ownerIdentity: `user:${dana}` })
    expect((await publish(h, agent, danaPrivate, { artifactId: first.artifactId })).revision).toBe(3)

    // Another agent reaches the org artifact but did not produce it.
    const other = await agentAndSession()
    const notMine = await refusal(
      h.service.begin(DEFAULT_ORG_ID, other.agent, {
        agentId: other.agentId,
        sessionId: other.sessionId,
        artifactId: first.artifactId,
        manifest: manifestOf(['index.html', 'x']),
        idempotencyKey: 'other-agent-0001',
        network: 'cluster'
      })
    )
    expect(notMine.reason).toBe('not-producer')

    // Dana's private artifact is absent from Erin's private session, even for its producer.
    const mine = await publish(h, agent, danaPrivate)
    const erinPrivate = await newSession(agentId, { visibility: 'private', ownerIdentity: `user:${erin}` })
    const unreachable = await refusal(
      h.service.begin(DEFAULT_ORG_ID, agent, {
        agentId,
        sessionId: erinPrivate,
        artifactId: mine.artifactId,
        manifest: manifestOf(['index.html', 'x']),
        idempotencyKey: 'erin-private-0001',
        network: 'cluster'
      })
    )
    expect(unreachable.reason).toBe('not-found')
    expect(
      (
        await refusal(
          h.service.fetch(DEFAULT_ORG_ID, {
            agentId,
            sessionId: erinPrivate,
            artifactId: mine.artifactId,
            network: 'public'
          })
        )
      ).reason
    ).toBe('not-found')
  })

  it('refuses a session of another agent, an unknown session as retryable, and a create without a title', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const other = await agentAndSession()
    const base = {
      agentId: agent.id,
      title: 'x',
      manifest: manifestOf(['a.md', '# a', 'text/markdown']),
      network: 'cluster' as const
    }
    const foreign = await refusal(
      h.service.begin(DEFAULT_ORG_ID, agent, { ...base, sessionId: other.sessionId, idempotencyKey: 'foreign-0001' })
    )
    expect(foreign.reason).toBe('session-denied')
    const unknown = await refusal(
      h.service.begin(DEFAULT_ORG_ID, agent, { ...base, sessionId: 'webchat:nope', idempotencyKey: 'unknown-0001' })
    )
    expect([unknown.reason, unknown.retryable]).toEqual(['session-unknown', true])
    const { title: _title, ...untitled } = base
    const noTitle = await refusal(
      h.service.begin(DEFAULT_ORG_ID, agent, { ...untitled, sessionId, idempotencyKey: 'untitled-0001' })
    )
    expect(noTitle.reason).toBe('title-required')
  })

  it('fetches a ready revision as GETs and lists what the session reaches with paging', async () => {
    const h = harness()
    const { agent, agentId, sessionId } = await agentAndSession()
    const first = await publish(h, agent, sessionId, {
      manifest: manifestOf(['index.html', '<p>1</p>'], ['app.js', 'x', 'text/javascript'])
    })
    await publish(h, agent, sessionId, { artifactId: first.artifactId })

    const latest = await h.service.fetch(DEFAULT_ORG_ID, {
      agentId,
      sessionId,
      artifactId: first.artifactId,
      network: 'public'
    })
    expect(latest.revision).toBe(2)
    const older = await h.service.fetch(DEFAULT_ORG_ID, {
      agentId,
      sessionId,
      artifactId: first.artifactId,
      revision: 1,
      network: 'public'
    })
    expect(older.downloads.map((d) => d.path)).toEqual(['index.html', 'app.js'])
    expect(new URL(older.downloads[0]!.url).host).toBe('store.example.test')
    expect(
      (
        await refusal(
          h.service.fetch(DEFAULT_ORG_ID, {
            agentId,
            sessionId,
            artifactId: first.artifactId,
            revision: 9,
            network: 'public'
          })
        )
      ).reason
    ).toBe('not-found')

    for (let i = 0; i < 25; i += 1) await publish(h, agent, sessionId)
    const page1 = await h.service.list(DEFAULT_ORG_ID, { agentId, sessionId })
    expect(page1.artifacts).toHaveLength(25)
    expect(page1.nextCursor).toBeDefined()
    const page2 = await h.service.list(DEFAULT_ORG_ID, { agentId, sessionId, cursor: page1.nextCursor! })
    const all = [...page1.artifacts, ...page2.artifacts]
    expect(page2.nextCursor).toBeUndefined()
    const listed = all.find((a) => a.artifactId === first.artifactId)
    expect(listed).toMatchObject({
      producedByAgent: true,
      latest: { revision: 2, entry: 'index.html', entryMediaType: 'text/html' }
    })
    expect(new Set(all.map((a) => a.artifactId)).size).toBe(all.length)
  })
})

describe('artifact read routes', () => {
  function appAs(userId: string, service: ReturnType<typeof harness>['service']): HttpApp {
    const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, undefined, { artifacts: service })
    opened.push(app)
    return app
  }

  it('answers metadata, the manifest and an attachment-only signed GET to a member in the audience', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const done = await publish(h, agent, sessionId, {
      initiator: { kind: 'console', userId: DEFAULT_OWNER_ID },
      manifest: manifestOf(['report.md', '# Q3', 'text/markdown'], ['img/chart.png', 'png', 'image/png'])
    })
    const app = appAs(DEFAULT_OWNER_ID, h.service).app
    const meta = await app.inject({ method: 'GET', url: `${ORG}/artifacts/${done.artifactId}` })
    expect(meta.statusCode).toBe(200)
    expect(meta.json()).toMatchObject({
      id: done.artifactId,
      title: 'Weekly report',
      audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
      owner: { userId: DEFAULT_OWNER_ID, platform: null },
      viewerIsOwner: true,
      originSessionId: sessionId,
      latestRevision: 1,
      revisions: [
        {
          number: 1,
          entry: 'report.md',
          entryMediaType: 'text/markdown',
          fileCount: 2,
          producedBy: { agentId: agent.id }
        }
      ]
    })

    const rev = await app.inject({ method: 'GET', url: `${ORG}/artifacts/${done.artifactId}/revisions/1` })
    expect(rev.statusCode).toBe(200)
    expect(rev.json().manifest.files.map((f: { path: string }) => f.path)).toEqual(['report.md', 'img/chart.png'])

    const file = await app.inject({
      method: 'GET',
      url: `${ORG}/artifacts/${done.artifactId}/revisions/1/file?path=${encodeURIComponent('img/chart.png')}`
    })
    expect(file.statusCode).toBe(200)
    expect(file.json()).toMatchObject({ path: 'img/chart.png', mediaType: 'image/png', bytes: 3 })
    const url = new URL(file.json().url)
    expect(url.host).toBe('store.example.test')
    expect(url.pathname).toBe(`/ac-cache/src/${DEFAULT_ORG_ID}/artifact/${done.artifactId}/1/img/chart.png`)
    expect(url.searchParams.get('response-content-disposition')).toBe(attachmentDisposition('chart.png'))
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream')

    for (const missing of [
      `${ORG}/artifacts/${done.artifactId}/revisions/2`,
      `${ORG}/artifacts/${done.artifactId}/revisions/1/file?path=other.md`,
      `${ORG}/artifacts/${randomUUID()}`
    ]) {
      expect((await app.inject({ method: 'GET', url: missing })).statusCode).toBe(404)
    }
  })

  it('answers 404 to everyone outside the audience, and while no revision is ready', async () => {
    const h = harness()
    const dana = await makeUser(`route-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`route-erin-${randomUUID()}`, 'collaborator')
    const viewer = await makeUser(`route-viewer-${randomUUID()}`, 'viewer')
    const priv = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana}` })
    const danas = await publish(h, priv.agent, priv.sessionId)
    const editors = await agentAndSession({ visibility: 'editors', ownerIdentity: 'slack:T1:U1' })
    const editorsArtifact = await publish(h, editors.agent, editors.sessionId)
    const orphan = await agentAndSession({ visibility: 'private' })
    const ownerless = await publish(h, orphan.agent, orphan.sessionId)
    const pending = await h.service.begin(DEFAULT_ORG_ID, priv.agent, {
      agentId: priv.agent.id,
      sessionId: priv.sessionId,
      title: 'Draft',
      manifest: manifestOf(['index.html', 'x']),
      idempotencyKey: 'pending-only-0001',
      network: 'cluster'
    })

    const status = async (userId: string, artifactId: string) =>
      (await appAs(userId, h.service).app.inject({ method: 'GET', url: `${ORG}/artifacts/${artifactId}` })).statusCode
    // A private artifact: its owner only; an organization owner gets no view of it.
    expect(await status(dana, danas.artifactId)).toBe(200)
    expect(await status(erin, danas.artifactId)).toBe(404)
    expect(await status(DEFAULT_OWNER_ID, danas.artifactId)).toBe(404)
    // `editors`: whoever can edit the agent now, which a viewer-role member cannot.
    expect(await status(erin, editorsArtifact.artifactId)).toBe(200)
    expect(await status(viewer, editorsArtifact.artifactId)).toBe(404)
    // No owner: organization owners only.
    expect(await status(DEFAULT_OWNER_ID, ownerless.artifactId)).toBe(200)
    expect(await status(erin, ownerless.artifactId)).toBe(404)
    // Nothing ready yet reads as absent even to its owner.
    expect(await status(dana, pending.artifactId)).toBe(404)
    const file = await appAs(erin, h.service).app.inject({
      method: 'GET',
      url: `${ORG}/artifacts/${danas.artifactId}/revisions/1/file?path=index.html`
    })
    expect(file.statusCode).toBe(404)
  })

  const sessionArtifacts = (sessionId: string, query = '') =>
    `${ORG}/sessions/${encodeURIComponent(sessionId)}/artifacts${query}`

  it('lists a session’s artifacts to whoever can view the session, leaving out those outside their audience', async () => {
    const h = harness()
    const repo = new PgArtifactRepo(prisma)
    const dana = await makeUser(`list-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`list-erin-${randomUUID()}`, 'collaborator')
    const { agent, agentId, sessionId } = await agentAndSession()
    const elsewhere = await newSession(agentId)

    // Published here, then revised elsewhere: listed, with the newer revision as its latest.
    const here = await publish(h, agent, sessionId)
    await publish(h, agent, elsewhere, {
      artifactId: here.artifactId,
      manifest: manifestOf(['report.md', '# Q3', 'text/markdown'], ['chart.png', 'png', 'image/png'])
    })
    // Published elsewhere, then revised here: listed.
    const revisedHere = await publish(h, agent, elsewhere)
    await publish(h, agent, sessionId, { artifactId: revisedHere.artifactId })
    // Published elsewhere only, with a revision here that never became ready: not listed.
    const notHere = await publish(h, agent, elsewhere)
    await h.service.begin(DEFAULT_ORG_ID, agent, {
      agentId,
      sessionId,
      artifactId: notHere.artifactId,
      manifest: manifestOf(['index.html', 'draft']),
      idempotencyKey: `pending-${randomUUID()}`,
      network: 'cluster'
    })
    // Dana's, narrowed to private after publication: listed for Dana alone.
    const danas = await publish(h, agent, sessionId, { initiator: { kind: 'console', userId: dana } })
    await repo.setVisibility(DEFAULT_ORG_ID, danas.artifactId, 'private')

    const list = async (userId: string, sid = sessionId) =>
      await appAs(userId, h.service).app.inject({ method: 'GET', url: sessionArtifacts(sid) })
    const ids = async (userId: string) =>
      ((await list(userId)).json().artifacts as Array<{ id: string }>).map((a) => a.id)

    expect(new Set(await ids(erin))).toEqual(new Set([here.artifactId, revisedHere.artifactId]))
    expect(new Set(await ids(dana))).toEqual(new Set([here.artifactId, revisedHere.artifactId, danas.artifactId]))
    // An organization owner sees no other member's private artifact.
    expect(await ids(DEFAULT_OWNER_ID)).not.toContain(danas.artifactId)

    const body = (await list(erin)).json()
    expect(body.nextCursor).toBeNull()
    expect(body.artifacts.find((a: { id: string }) => a.id === here.artifactId)).toMatchObject({
      id: here.artifactId,
      title: 'Weekly report',
      audience: { visibility: 'org', externalProvider: null, editorsAgentId: null },
      owner: null,
      viewerIsOwner: false,
      originSessionId: sessionId,
      latestRevision: 2,
      latest: {
        number: 2,
        entry: 'report.md',
        entryMediaType: 'text/markdown',
        fileCount: 2,
        totalBytes: Buffer.byteLength('# Q3') + Buffer.byteLength('png'),
        producedBy: { agentId, name: agent.name },
        producedInSessionId: elsewhere
      }
    })
    expect(body.artifacts[0]).not.toHaveProperty('revisions')
    const danaView = (await list(dana)).json().artifacts.find((a: { id: string }) => a.id === danas.artifactId)
    expect(danaView).toMatchObject({
      viewerIsOwner: true,
      owner: { userId: dana },
      latest: { producedInSessionId: sessionId }
    })

    // A session the caller cannot view, or none at all, is not found, whatever its artifacts' audience.
    const danaPrivate = await newSession(agentId, { visibility: 'private', ownerIdentity: `user:${dana}` })
    await publish(h, agent, danaPrivate)
    expect((await list(dana, danaPrivate)).statusCode).toBe(200)
    expect((await list(erin, danaPrivate)).statusCode).toBe(404)
    expect((await list(erin, `webchat:${randomUUID()}`)).statusCode).toBe(404)
  })

  it('orders a session’s artifacts by latest activity and pages them with a cursor', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const published: string[] = []
    for (let i = 0; i < 5; i += 1) published.push((await publish(h, agent, sessionId)).artifactId)
    // Pin activity times so the expected order does not hang on clock resolution; the first one is the most recent.
    for (const [i, id] of published.entries()) {
      await prisma.artifact.update({ where: { id }, data: { updatedAt: new Date(T0 + (i === 0 ? 99 : i) * 1000) } })
    }
    const expected = [published[0], published[4], published[3], published[2], published[1]]
    const app = appAs(DEFAULT_OWNER_ID, h.service).app

    const paged: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await app.inject({
        method: 'GET',
        url: sessionArtifacts(sessionId, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      })
      expect(res.statusCode).toBe(200)
      const page = res.json() as { artifacts: Array<{ id: string }>; nextCursor: string | null }
      expect(page.artifacts.length).toBeLessThanOrEqual(2)
      paged.push(...page.artifacts.map((a) => a.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor)
    expect(paged).toEqual(expected)
    expect(pages).toBe(3)

    expect(
      (await app.inject({ method: 'GET', url: sessionArtifacts(sessionId, '?cursor=not-a-cursor') })).statusCode
    ).toBe(400)
    expect((await app.inject({ method: 'GET', url: sessionArtifacts(sessionId, '?limit=51') })).statusCode).toBe(400)
  })

  it('refuses every route as not enabled, whatever the artifact, on a deployment without the feature', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const done = await publish(h, agent, sessionId)
    const off = buildHttpApp(prisma, { DEFAULT_OWNER_ID })
    opened.push(off)
    for (const url of [
      `${ORG}/artifacts/${done.artifactId}`,
      `${ORG}/artifacts/${done.artifactId}/revisions/1`,
      `${ORG}/artifacts/${done.artifactId}/revisions/1/file?path=index.html`,
      `${ORG}/artifacts/${randomUUID()}`,
      `${ORG}/sessions/${encodeURIComponent(sessionId)}/artifacts`
    ]) {
      const res = await off.app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'ARTIFACTS_NOT_ENABLED' })
    }
  })
})
