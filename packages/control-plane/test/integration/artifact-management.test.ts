// The Artifacts page routes (artifacts.md §6.3, §11.5): the organization list, rename and audience change, and public-share moderation.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { agentAndSession, harness, makeUser, manifestOf, publish, T0 } from '../fixtures/artifacts.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

type Service = ReturnType<typeof harness>['service']

function appAs(userId: string, service?: Service) {
  const built = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, undefined, {
    ...(service ? { artifacts: service } : {})
  })
  opened.push(built)
  return built.app
}

interface Row {
  id: string
  title: string
  kind: string
  owner: { userId: string | null } | null
  viewerIsOwner: boolean
  originSessionId: string | null
  originSessionVisible: boolean
  shared: { any: boolean; public: boolean }
  permissions: { rename: boolean; changeAudience: boolean; sharePublic: boolean; revokeShares: boolean }
  latest: { number: number; totalBytes: number; entryMediaType: string; producedBy: { agentId: string; name: string } }
}

async function listAs(userId: string, service: Service, query = '') {
  const res = await appAs(userId, service).inject({ method: 'GET', url: `${ORG}/artifacts${query}` })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as { artifacts: Row[]; nextCursor: string | null }
}

const idsOf = async (userId: string, service: Service, query = '') =>
  new Set((await listAs(userId, service, query)).artifacts.map((row) => row.id))

/** Every page of a list, following `nextCursor`. */
async function allPages(userId: string, service: Service, query: string) {
  const ids: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await listAs(userId, service, `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    ids.push(...page.artifacts.map((row) => row.id))
    cursor = page.nextCursor
    pages += 1
  } while (cursor && pages < 50)
  return { ids, pages }
}

const share = async (userId: string, service: Service, artifactId: string, audience: 'public' | 'org') => {
  const res = await appAs(userId, service).inject({
    method: 'POST',
    url: `${ORG}/artifacts/${artifactId}/shares`,
    payload: { revision: 1, audience }
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json().id as string
}

describe('organization artifact list', () => {
  it('lists exactly what each member can view, with the page’s columns and permissions', async () => {
    const h = harness()
    const dana = await makeUser(`list-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`list-erin-${randomUUID()}`, 'collaborator')
    const viewer = await makeUser(`list-viewer-${randomUUID()}`, 'viewer')

    const priv = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana}` })
    const danaPrivate = await publish(h, priv.agent, priv.sessionId)
    const org = await agentAndSession()
    const danaOrg = await publish(h, org.agent, org.sessionId, {
      initiator: { kind: 'console', userId: dana },
      manifest: manifestOf(['report.md', '# Q3', 'text/markdown'], ['chart.png', 'png', 'image/png'])
    })
    const editors = await agentAndSession({ visibility: 'editors', ownerIdentity: 'slack:T1:U1' })
    const editorsArtifact = await publish(h, editors.agent, editors.sessionId)
    const orphan = await agentAndSession({ visibility: 'private' })
    const ownerless = await publish(h, orphan.agent, orphan.sessionId)
    // Widened by Dana from her private session: Erin sees the artifact but not the session it came from.
    const widened = await publish(h, priv.agent, priv.sessionId)
    await prisma.artifact.update({ where: { id: widened.artifactId }, data: { visibility: 'org' } })
    // An origin session that has been purged.
    const purged = await publish(h, org.agent, org.sessionId)
    await prisma.artifact.update({
      where: { id: purged.artifactId },
      data: { originSessionId: `webchat:${randomUUID()}` }
    })

    const everyoneSees = [danaOrg.artifactId, widened.artifactId, purged.artifactId]
    expect(await idsOf(dana, h.service)).toEqual(
      new Set([...everyoneSees, danaPrivate.artifactId, editorsArtifact.artifactId])
    )
    expect(await idsOf(erin, h.service)).toEqual(new Set([...everyoneSees, editorsArtifact.artifactId]))
    expect(await idsOf(viewer, h.service)).toEqual(new Set(everyoneSees))
    // An organization owner sees no other member's private artifact, but every ownerless one and every editors one.
    expect(await idsOf(DEFAULT_OWNER_ID, h.service)).toEqual(
      new Set([...everyoneSees, editorsArtifact.artifactId, ownerless.artifactId])
    )

    await share(dana, h.service, danaOrg.artifactId, 'public')
    await share(erin, h.service, widened.artifactId, 'org')
    const rows = new Map((await listAs(erin, h.service)).artifacts.map((row) => [row.id, row]))
    expect(rows.get(danaOrg.artifactId)).toMatchObject({
      title: 'Weekly report',
      kind: 'document',
      owner: { userId: dana },
      viewerIsOwner: false,
      originSessionId: org.sessionId,
      originSessionVisible: true,
      shared: { any: true, public: true },
      permissions: { rename: false, changeAudience: false, sharePublic: false, revokeShares: false },
      latest: {
        number: 1,
        entryMediaType: 'text/markdown',
        totalBytes: Buffer.byteLength('# Q3') + Buffer.byteLength('png'),
        producedBy: { agentId: org.agentId, name: org.agent.name }
      }
    })
    expect(rows.get(widened.artifactId)).toMatchObject({
      kind: 'page',
      originSessionVisible: false,
      shared: { any: true, public: false }
    })
    expect(rows.get(purged.artifactId)).toMatchObject({ originSessionVisible: false, shared: { any: false } })

    const danaRows = new Map((await listAs(dana, h.service)).artifacts.map((row) => [row.id, row]))
    expect(danaRows.get(danaOrg.artifactId)).toMatchObject({
      viewerIsOwner: true,
      permissions: { rename: true, changeAudience: true, sharePublic: true, revokeShares: true }
    })
    const ownerRows = new Map((await listAs(DEFAULT_OWNER_ID, h.service)).artifacts.map((row) => [row.id, row]))
    // An organization owner manages what they can view, but cannot move an editors audience.
    expect(ownerRows.get(editorsArtifact.artifactId)?.permissions).toEqual({
      rename: true,
      changeAudience: false,
      sharePublic: true,
      revokeShares: true
    })
    expect(ownerRows.get(ownerless.artifactId)?.permissions).toMatchObject({ rename: true, changeAudience: true })
  })

  it('filters by owner, producing agent, type and public sharing', async () => {
    const h = harness()
    const dana = await makeUser(`filter-dana-${randomUUID()}`, 'collaborator')
    const first = await agentAndSession()
    const second = await agentAndSession()
    const danaPage = await publish(h, first.agent, first.sessionId, { initiator: { kind: 'console', userId: dana } })
    const danaPdf = await publish(h, second.agent, second.sessionId, {
      initiator: { kind: 'console', userId: dana },
      manifest: manifestOf(
        ['report.pdf', '%PDF', 'application/pdf'],
        ['report.docx', 'docx', 'application/octet-stream']
      )
    })
    const unowned = await publish(h, first.agent, first.sessionId, {
      manifest: manifestOf(['data.json', '{}', 'application/json'])
    })
    const docx = await publish(h, second.agent, second.sessionId, {
      manifest: manifestOf(['notes.docx', 'docx', 'application/octet-stream'])
    })
    // A later revision by the same agent turns the page into Markdown: the type follows the latest revision.
    const revised = await publish(h, first.agent, first.sessionId)
    await publish(h, first.agent, first.sessionId, {
      artifactId: revised.artifactId,
      manifest: manifestOf(['README.md', '# hi', 'text/plain'])
    })
    await share(dana, h.service, danaPdf.artifactId, 'public')
    await share(dana, h.service, danaPage.artifactId, 'org')

    expect(await idsOf(dana, h.service, '?scope=mine')).toEqual(new Set([danaPage.artifactId, danaPdf.artifactId]))
    expect(await idsOf(DEFAULT_OWNER_ID, h.service, '?scope=mine')).toEqual(new Set())
    expect(await idsOf(dana, h.service, `?agentId=${first.agentId}`)).toEqual(
      new Set([danaPage.artifactId, unowned.artifactId, revised.artifactId])
    )
    expect(await idsOf(dana, h.service, '?type=pdf')).toEqual(new Set([danaPdf.artifactId]))
    expect(await idsOf(dana, h.service, '?type=page')).toEqual(new Set([danaPage.artifactId]))
    expect(await idsOf(dana, h.service, '?type=document')).toEqual(new Set([revised.artifactId]))
    expect(await idsOf(dana, h.service, '?type=code')).toEqual(new Set([unowned.artifactId]))
    expect(await idsOf(dana, h.service, '?type=other')).toEqual(new Set([docx.artifactId]))
    expect(await idsOf(dana, h.service, '?publiclyShared=true')).toEqual(new Set([danaPdf.artifactId]))
    expect(await idsOf(dana, h.service, `?scope=mine&agentId=${second.agentId}&publiclyShared=true`)).toEqual(
      new Set([danaPdf.artifactId])
    )

    const app = appAs(dana, h.service)
    for (const query of [
      '?type=word',
      '?scope=all',
      '?agentId=nope',
      '?publiclyShared=false',
      '?cursor=bad',
      '?limit=51'
    ]) {
      expect((await app.inject({ method: 'GET', url: `${ORG}/artifacts${query}` })).statusCode, query).toBe(400)
    }
  })

  it('pages newest update first, across a type filter that skips most rows', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const published: Array<{ id: string; markdown: boolean }> = []
    for (let i = 0; i < 12; i += 1) {
      const markdown = i % 4 === 0
      const done = await publish(h, agent, sessionId, {
        ...(markdown ? { manifest: manifestOf(['notes.md', '# n', 'text/markdown']) } : {})
      })
      published.push({ id: done.artifactId, markdown })
    }
    // Pin the order: the last published is the most recently updated.
    for (const [i, { id }] of published.entries()) {
      await prisma.artifact.update({ where: { id }, data: { updatedAt: new Date(T0 + i * 1000) } })
    }
    const newestFirst = published.map((p) => p.id).reverse()

    const plain = await allPages(DEFAULT_OWNER_ID, h.service, '?limit=5')
    expect(plain).toEqual({ ids: newestFirst, pages: 3 })
    const markdown = published
      .filter((p) => p.markdown)
      .map((p) => p.id)
      .reverse()
    const filtered = await allPages(DEFAULT_OWNER_ID, h.service, '?limit=2&type=document')
    expect(filtered.ids).toEqual(markdown)
    expect(await listAs(DEFAULT_OWNER_ID, h.service, '?limit=1&type=pdf')).toEqual({ artifacts: [], nextCursor: null })
  })
})

describe('artifact rename and audience change', () => {
  const patch = (userId: string, service: Service, artifactId: string, payload: object) =>
    appAs(userId, service).inject({ method: 'PATCH', url: `${ORG}/artifacts/${artifactId}`, payload })

  it('lets the owner, and an organization owner who can view, rename and move between private and org', async () => {
    const h = harness()
    const dana = await makeUser(`patch-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`patch-erin-${randomUUID()}`, 'collaborator')
    const priv = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana}` })
    const danaPrivate = await publish(h, priv.agent, priv.sessionId)
    const org = await agentAndSession()
    const danaOrg = await publish(h, org.agent, org.sessionId, { initiator: { kind: 'console', userId: dana } })

    const renamed = await patch(dana, h.service, danaPrivate.artifactId, { title: 'Q3 numbers' })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({
      id: danaPrivate.artifactId,
      title: 'Q3 numbers',
      audience: { visibility: 'private' },
      viewerIsOwner: true,
      revisions: [{ number: 1 }]
    })
    // An organization owner cannot view Dana's private artifact, so it does not exist for them.
    expect((await patch(DEFAULT_OWNER_ID, h.service, danaPrivate.artifactId, { title: 'x' })).statusCode).toBe(404)
    expect((await patch(DEFAULT_OWNER_ID, h.service, danaPrivate.artifactId, { audience: 'org' })).statusCode).toBe(404)
    expect((await patch(erin, h.service, danaPrivate.artifactId, { title: 'x' })).statusCode).toBe(404)

    // Dana widens it, keeping its share; Erin now sees it but still may not change it.
    const shareId = await share(dana, h.service, danaPrivate.artifactId, 'public')
    const widened = await patch(dana, h.service, danaPrivate.artifactId, { audience: 'org', title: 'Q3 final' })
    expect(widened.json()).toMatchObject({ title: 'Q3 final', audience: { visibility: 'org' } })
    expect(await idsOf(erin, h.service)).toContain(danaPrivate.artifactId)
    const forbidden = await patch(erin, h.service, danaPrivate.artifactId, { title: 'mine now' })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toMatchObject({ code: 'ARTIFACT_UPDATE_FORBIDDEN' })
    expect((await patch(erin, h.service, danaPrivate.artifactId, { audience: 'private' })).statusCode).toBe(403)
    expect(await prisma.artifactShare.findUniqueOrThrow({ where: { id: shareId } })).toMatchObject({
      audience: 'public',
      revokedAt: null
    })

    // An organization owner who can view an org artifact renames it and narrows it, which hides it from them.
    expect((await patch(DEFAULT_OWNER_ID, h.service, danaOrg.artifactId, { title: 'Moderated' })).statusCode).toBe(200)
    expect((await patch(DEFAULT_OWNER_ID, h.service, danaOrg.artifactId, { audience: 'private' })).statusCode).toBe(200)
    expect(await idsOf(DEFAULT_OWNER_ID, h.service)).not.toContain(danaOrg.artifactId)
    expect((await patch(DEFAULT_OWNER_ID, h.service, danaOrg.artifactId, { audience: 'org' })).statusCode).toBe(404)
    expect((await patch(dana, h.service, danaOrg.artifactId, { audience: 'org' })).statusCode).toBe(200)

    for (const body of [
      {},
      { title: '' },
      { title: '   ' },
      { title: 'a\nb' },
      { audience: 'external' },
      { owner: 'x' }
    ]) {
      expect((await patch(dana, h.service, danaOrg.artifactId, body)).statusCode, JSON.stringify(body)).toBe(400)
    }
    expect((await patch(dana, h.service, randomUUID(), { title: 'x' })).statusCode).toBe(404)
  })

  it('manages an ownerless artifact through organization owners, and never moves an editors audience', async () => {
    const h = harness()
    const erin = await makeUser(`patch-editor-${randomUUID()}`, 'collaborator')
    const orphan = await agentAndSession({ visibility: 'private' })
    const ownerless = await publish(h, orphan.agent, orphan.sessionId)
    const editors = await agentAndSession({ visibility: 'editors', ownerIdentity: 'slack:T1:U1' })
    const editorsArtifact = await publish(h, editors.agent, editors.sessionId)

    expect((await patch(erin, h.service, ownerless.artifactId, { title: 'x' })).statusCode).toBe(404)
    expect((await patch(DEFAULT_OWNER_ID, h.service, ownerless.artifactId, { audience: 'org' })).statusCode).toBe(200)
    expect(await idsOf(erin, h.service)).toContain(ownerless.artifactId)

    // Erin edits the agent so she views the artifact, but she does not own it.
    expect((await patch(erin, h.service, editorsArtifact.artifactId, { title: 'x' })).statusCode).toBe(403)
    expect(
      (await patch(DEFAULT_OWNER_ID, h.service, editorsArtifact.artifactId, { title: 'Renamed' })).statusCode
    ).toBe(200)
    const fixed = await patch(DEFAULT_OWNER_ID, h.service, editorsArtifact.artifactId, { audience: 'org', title: 'No' })
    expect(fixed.statusCode).toBe(409)
    expect(fixed.json()).toMatchObject({ code: 'ARTIFACT_AUDIENCE_FIXED' })
    expect(await prisma.artifact.findUniqueOrThrow({ where: { id: editorsArtifact.artifactId } })).toMatchObject({
      title: 'Renamed',
      visibility: 'editors'
    })
  })
})

describe('public share moderation', () => {
  it('shows organization owners every active public share’s metadata and lets them revoke without viewing', async () => {
    const h = harness()
    const dana = await makeUser(`mod-dana-${randomUUID()}`, 'collaborator')
    const erin = await makeUser(`mod-erin-${randomUUID()}`, 'collaborator')
    const priv = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana}` })
    const danaPrivate = await publish(h, priv.agent, priv.sessionId)
    const org = await agentAndSession()
    const orgArtifact = await publish(h, org.agent, org.sessionId, { initiator: { kind: 'console', userId: dana } })

    const hidden = await share(dana, h.service, danaPrivate.artifactId, 'public')
    const visible = await share(erin, h.service, orgArtifact.artifactId, 'org')
    const publicOrg = await share(dana, h.service, orgArtifact.artifactId, 'public')
    const revoked = await share(dana, h.service, orgArtifact.artifactId, 'public')
    await appAs(dana, h.service).inject({
      method: 'DELETE',
      url: `${ORG}/artifacts/${orgArtifact.artifactId}/shares/${revoked}`
    })
    for (const [i, id] of [hidden, visible, publicOrg, revoked].entries()) {
      await prisma.artifactShare.update({ where: { id }, data: { createdAt: new Date(T0 + i * 1000) } })
    }

    const owner = appAs(DEFAULT_OWNER_ID, h.service)
    const res = await owner.inject({ method: 'GET', url: `${ORG}/artifact-shares?audience=public` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { shares: Array<Record<string, unknown>>; nextCursor: string | null }
    expect(body.nextCursor).toBeNull()
    expect(body.shares.map((s) => s.id)).toEqual([publicOrg, hidden])
    expect(body.shares[1]).toMatchObject({
      id: hidden,
      artifactId: danaPrivate.artifactId,
      revision: 1,
      audience: 'public',
      displayTail: expect.stringMatching(/^….{6}$/),
      createdBy: { userId: dana, platform: null },
      createdAt: new Date(T0).toISOString(),
      revokedAt: null,
      artifact: { id: danaPrivate.artifactId, title: 'Weekly report', owner: { userId: dana }, viewerCanView: false }
    })
    expect(Object.keys(body.shares[1]!.artifact as object).sort()).toEqual(['id', 'owner', 'title', 'viewerCanView'])
    expect(body.shares[0]).toMatchObject({ artifact: { id: orgArtifact.artifactId, viewerCanView: true } })
    expect(JSON.stringify(body)).not.toMatch(/manifest|token|index\.html/)
    expect(body.shares.map((s) => s.id)).not.toContain(visible)

    // Without viewing the private artifact, the organization owner revokes its public link.
    expect(
      (await owner.inject({ method: 'DELETE', url: `${ORG}/artifacts/${danaPrivate.artifactId}/shares/${hidden}` }))
        .statusCode
    ).toBe(204)
    expect((await owner.inject({ method: 'GET', url: `${ORG}/artifacts/${danaPrivate.artifactId}` })).statusCode).toBe(
      404
    )
    const after = (await owner.inject({ method: 'GET', url: `${ORG}/artifact-shares` })).json()
    expect(after.shares.map((s: { id: string }) => s.id)).toEqual([publicOrg])

    for (const member of [dana, erin]) {
      const refused = await appAs(member, h.service).inject({ method: 'GET', url: `${ORG}/artifact-shares` })
      expect(refused.statusCode).toBe(403)
      expect(refused.json()).toMatchObject({ code: 'ARTIFACT_MODERATION_FORBIDDEN' })
    }
    expect((await owner.inject({ method: 'GET', url: `${ORG}/artifact-shares?audience=org` })).statusCode).toBe(400)
  })

  it('pages the public shares newest first', async () => {
    const h = harness()
    const { agent, sessionId } = await agentAndSession()
    const done = await publish(h, agent, sessionId, { initiator: { kind: 'console', userId: DEFAULT_OWNER_ID } })
    const created: string[] = []
    for (let i = 0; i < 5; i += 1) created.push(await share(DEFAULT_OWNER_ID, h.service, done.artifactId, 'public'))
    for (const [i, id] of created.entries()) {
      await prisma.artifactShare.update({ where: { id }, data: { createdAt: new Date(T0 + i * 1000) } })
    }
    const owner = appAs(DEFAULT_OWNER_ID, h.service)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const res = await owner.inject({
        method: 'GET',
        url: `${ORG}/artifact-shares?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      })
      const page = res.json() as { shares: Array<{ id: string }>; nextCursor: string | null }
      seen.push(...page.shares.map((s) => s.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([...created].reverse())
  })
})

it('answers the page routes as not enabled on a deployment without artifacts', async () => {
  const off = appAs(DEFAULT_OWNER_ID)
  for (const [method, url] of [
    ['GET', `${ORG}/artifacts`],
    ['PATCH', `${ORG}/artifacts/${randomUUID()}`],
    ['GET', `${ORG}/artifact-shares`]
  ] as const) {
    const res = await off.inject({ method, url, ...(method === 'PATCH' ? { payload: { title: 'x' } } : {}) })
    expect(res.statusCode, url).toBe(409)
    expect(res.json()).toMatchObject({ code: 'ARTIFACTS_NOT_ENABLED' })
  }
})
