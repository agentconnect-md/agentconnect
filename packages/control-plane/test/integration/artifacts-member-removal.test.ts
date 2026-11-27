// A departed member's artifacts pass to organization owners on every removal path (artifacts.md D21, §6.3).
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { agentAndSession, harness, makeUser, publish } from '../fixtures/artifacts.js'
import { PgUserRepo } from '../../src/persistence/index.js'
import type { SessionAccessPlugin } from '../../src/http/session-access-plugin.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

type Service = ReturnType<typeof harness>['service']
function appAs(userId: string, service: Service, plugins?: SessionAccessPlugin[]): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, undefined, {
    artifacts: service,
    ...(plugins ? { sessionAccessPlugins: plugins } : {})
  })
  opened.push(app)
  return app
}

const ownerOf = async (id: string) => (await prisma.artifact.findUniqueOrThrow({ where: { id } })).ownerIdentity
const view = async (app: HttpApp, id: string) =>
  (await app.app.inject({ method: 'GET', url: `${ORG}/artifacts/${id}` })).statusCode

/** A private artifact owned by `ownerIdentity`, published from that owner's private session. */
async function privateArtifact(h: ReturnType<typeof harness>, ownerIdentity: string) {
  const { agent, sessionId } = await agentAndSession({ visibility: 'private', ownerIdentity })
  return (await publish(h, agent, sessionId)).artifactId
}

/** An org-audience artifact whose publishing turn `userId` started. */
async function orgArtifact(h: ReturnType<typeof harness>, userId: string) {
  const { agent, sessionId } = await agentAndSession()
  return (await publish(h, agent, sessionId, { initiator: { kind: 'console', userId } })).artifactId
}

describe('member removal — artifacts', () => {
  it('passes a removed member’s artifacts to organization owners, never to other members, and not back on return', async () => {
    const h = harness()
    const danaSub = `art-leave-dana-${randomUUID()}`
    const dana = await makeUser(danaSub, 'collaborator')
    const erin = await makeUser(`art-leave-erin-${randomUUID()}`, 'collaborator')
    const priv = await privateArtifact(h, `user:${dana}`)
    const shared = await orgArtifact(h, dana)
    const erins = await privateArtifact(h, `user:${erin}`)
    // A row of another organization carries the same identity and is not this removal's.
    const elsewhere = randomUUID()
    await prisma.artifact.create({
      data: {
        id: elsewhere,
        orgId: `other-org-${randomUUID()}`,
        title: 'x',
        visibility: 'private',
        ownerIdentity: `user:${dana}`
      }
    })
    const asOwner = appAs(DEFAULT_OWNER_ID, h.service)
    const asErin = appAs(erin, h.service)
    expect(await view(asOwner, priv)).toBe(404)
    // Dana's org share outlives her membership: it is the artifact's, not hers.
    const share = await appAs(dana, h.service).app.inject({
      method: 'POST',
      url: `${ORG}/artifacts/${shared}/shares`,
      payload: { revision: 1, audience: 'org' }
    })
    expect(share.statusCode).toBe(201)

    expect((await asOwner.app.inject({ method: 'DELETE', url: `${ORG}/members/${dana}` })).statusCode).toBe(204)

    expect(await ownerOf(priv)).toBeNull()
    expect(await ownerOf(shared)).toBeNull()
    expect(await ownerOf(erins)).toBe(`user:${erin}`)
    expect(await ownerOf(elsewhere)).toBe(`user:${dana}`)
    // The formerly private artifact is the organization owners' to view and manage, and still no one else's.
    expect(await view(asOwner, priv)).toBe(200)
    expect(await view(asErin, priv)).toBe(404)
    const publicShare = await asOwner.app.inject({
      method: 'POST',
      url: `${ORG}/artifacts/${priv}/shares`,
      payload: { revision: 1, audience: 'public' }
    })
    expect(publicShare.statusCode).toBe(201)
    // The org-audience artifact reads as before, ownerless.
    expect(await view(asErin, shared)).toBe(200)
    expect((await asErin.app.inject({ method: 'GET', url: `${ORG}/artifacts/${shared}` })).json()).toMatchObject({
      owner: null,
      viewerIsOwner: false
    })
    expect(await prisma.artifactShare.count({ where: { artifactId: shared, revokedAt: null } })).toBe(1)

    // Coming back does not restore ownership: the private artifact stays with organization owners.
    await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, `${danaSub}@example.test`, 'collaborator')
    expect(await ownerOf(priv)).toBeNull()
    expect(await view(appAs(dana, h.service), priv)).toBe(404)
  })

  it('clears the artifacts of a member who leaves, including those owned by a linked chat identity', async () => {
    const h = harness()
    const danaSub = `art-self-dana-${randomUUID()}`
    const dana = await makeUser(danaSub, 'collaborator')
    const linked = `slack:T_EXAMPLE:U_DANA_${randomUUID()}`
    const someoneElse = `slack:T_EXAMPLE:U_OTHER_${randomUUID()}`
    const plugin: SessionAccessPlugin = {
      provider: 'slack',
      available: true,
      resolve: async () => ({ allowedScopes: [], degraded: false }),
      addViewerIdentities: async (viewer) => {
        if (viewer.request.oidcSubject === danaSub) viewer.identitySet.add(linked)
      }
    }
    const throwing: SessionAccessPlugin = {
      provider: 'feishu',
      available: true,
      resolve: async () => ({ allowedScopes: [], degraded: false }),
      addViewerIdentities: async () => {
        throw new Error('identity service unavailable')
      }
    }
    const own = await privateArtifact(h, `user:${dana}`)
    const viaSlack = await privateArtifact(h, linked)
    const notHers = await privateArtifact(h, someoneElse)

    // One provider failing does not keep the member in the organization or stop the others.
    const asDana = appAs(dana, h.service, [plugin, throwing])
    expect((await asDana.app.inject({ method: 'DELETE', url: `${ORG}/members/${dana}` })).statusCode).toBe(204)

    expect(await ownerOf(own)).toBeNull()
    expect(await ownerOf(viaSlack)).toBeNull()
    expect(await ownerOf(notHers)).toBe(someoneElse)
    expect(await view(appAs(DEFAULT_OWNER_ID, h.service), viaSlack)).toBe(200)
  })

  it('clears them when the member deletes their account', async () => {
    const h = harness()
    const dana = await makeUser(`art-account-dana-${randomUUID()}`, 'collaborator')
    const priv = await privateArtifact(h, `user:${dana}`)
    expect((await appAs(dana, h.service).app.inject({ method: 'DELETE', url: '/api/v1/me' })).statusCode).toBe(204)
    expect(await ownerOf(priv)).toBeNull()
  })

  it('clears a deleted service account’s artifacts', async () => {
    const h = harness()
    const account = await new PgUserRepo(prisma).createServiceAccount(DEFAULT_ORG_ID, {
      name: 'reporter',
      role: 'collaborator'
    })
    const theirs = await privateArtifact(h, `user:${account.userId}`)
    expect(await ownerOf(theirs)).toBe(`user:${account.userId}`)
    const res = await appAs(DEFAULT_OWNER_ID, h.service).app.inject({
      method: 'DELETE',
      url: `${ORG}/service-accounts/${account.userId}`
    })
    expect(res.statusCode).toBe(204)
    expect(await ownerOf(theirs)).toBeNull()
  })

  it('gives no owner to an artifact published for a member who has already left', async () => {
    const h = harness()
    const dana = await makeUser(`art-late-dana-${randomUUID()}`, 'collaborator')
    const { agent, sessionId } = await agentAndSession({ visibility: 'private', ownerIdentity: `user:${dana}` })
    await new PgUserRepo(prisma).removeMember(DEFAULT_ORG_ID, dana, DEFAULT_OWNER_ID)
    const late = await publish(h, agent, sessionId)
    expect(late.audience).toEqual({ visibility: 'private', owned: false })
    expect(await ownerOf(late.artifactId)).toBeNull()
  })
})
