/**
 * Session visibility end-to-end (docs/designs/session-visibility.md §9).
 *
 * Exercises the CP read gates, the §4.3 reclassification endpoint, and the §4.5
 * cascade semantics against real Postgres and the real HTTP stack. Under devAuth
 * the principal is fixed, so a second app built with `{ DEFAULT_OWNER_ID }` is
 * how we "act as" another member — same idiom as visibility.route.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { SessionId } from '../../src/domain/ids.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const users = () => new PgUserRepo(prisma)
const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@acme.dev`
  const { userId } = await users().provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users().addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

function appAs(userId: string): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(app)
  return app
}

const sessionIds = (body: unknown): string[] =>
  (body as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)

describe('session visibility — list & detail', () => {
  it('a collaborator sees org sessions and their own private ones, never another member’s', async () => {
    const mine = await makeUser('sv-mine', 'collaborator')
    const theirs = await makeUser('sv-theirs', 'collaborator')
    const owner = await makeUser('sv-owner', 'owner')

    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const orgSession = await seedSessionMeta(prisma, `s-org-${randomUUID()}`, agentId, {})
    const ownSession = await seedSessionMeta(prisma, `s-own-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${mine}`
    })
    const otherSession = await seedSessionMeta(prisma, `s-other-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${theirs}`
    })
    // No resolvable owner (ownerIdentity null — nothing for identity linking
    // to match, unlike a §2 owner-orphan's stored tuple): visible to no one.
    const orphanSession = await seedSessionMeta(prisma, `s-orphan-${randomUUID()}`, agentId, {
      visibility: 'private'
    })

    const mineApp = appAs(mine)
    const listed = sessionIds((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions` })).json())
    expect(listed).toEqual(expect.arrayContaining([orgSession, ownSession]))
    expect(listed).not.toContain(otherSession)
    expect(listed).not.toContain(orphanSession)

    // Detail is 404 (never 403) for a session the caller cannot see.
    expect((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${ownSession}` })).statusCode).toBe(200)
    expect((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${otherSession}` })).statusCode).toBe(404)
    expect((await mineApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${orphanSession}` })).statusCode).toBe(404)

    // No governance override on sessions: an org owner filters exactly like any
    // other member — a private transcript is its owner's, role grants nothing.
    const ownerApp = appAs(owner)
    const asOwner = sessionIds((await ownerApp.app.inject({ method: 'GET', url: `${ORG}/sessions` })).json())
    expect(asOwner).toContain(orgSession)
    expect(asOwner).not.toContain(ownSession)
    expect(asOwner).not.toContain(otherSession)
    expect(asOwner).not.toContain(orphanSession)
    expect((await ownerApp.app.inject({ method: 'GET', url: `${ORG}/sessions/${otherSession}` })).statusCode).toBe(404)
  })

  it('reports orgHasSessions even when every session is hidden from the caller', async () => {
    const viewer = await makeUser('sv-ohs-viewer', 'collaborator')
    const other = await makeUser('sv-ohs-other', 'collaborator')

    // Before any session exists: the boolean is present and false on the first page.
    const viewerApp = appAs(viewer)
    const emptyPage = (await viewerApp.app.inject({ method: 'GET', url: `${ORG}/sessions` })).json() as {
      sessions: unknown[]
      orgHasSessions?: boolean
    }
    expect(emptyPage.orgHasSessions).toBe(false)

    // The org's ONLY session is another member's private one — invisible to the
    // viewer, but the bare boolean still reports the org has sessions, so the
    // getting-started conversation step doesn't ask for a redundant chat.
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    await seedSessionMeta(prisma, `s-ohs-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${other}`
    })
    const page = (await viewerApp.app.inject({ method: 'GET', url: `${ORG}/sessions` })).json() as {
      sessions: unknown[]
      orgHasSessions?: boolean
    }
    expect(page.sessions).toHaveLength(0)
    expect(page.orgHasSessions).toBe(true)
  })

  it('keeps keyset pagination stable under the visibility predicate', async () => {
    const viewer = await makeUser('sv-page', 'collaborator')
    const other = await makeUser('sv-page-other', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    // Interleave visible and hidden rows so a page boundary lands mid-run.
    const visible: string[] = []
    for (let i = 0; i < 6; i++) {
      const at = new Date(Date.now() - i * 1000)
      const isHidden = i % 2 === 1
      const id = await seedSessionMeta(prisma, `s-page-${i}-${randomUUID()}`, agentId, {
        lastActivityAt: at,
        ...(isHidden ? { visibility: 'private' as const, ownerIdentity: `user:${other}` } : {})
      })
      if (!isHidden) visible.push(id)
    }

    const app = appAs(viewer)
    const collected: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const url = `${ORG}/sessions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const body = (await app.app.inject({ method: 'GET', url })).json() as {
        sessions: Array<{ sessionId: string }>
        nextCursor: string | null
      }
      collected.push(...body.sessions.map((s) => s.sessionId))
      cursor = body.nextCursor
      if (!cursor) break
    }
    // Every visible row exactly once, newest-first, with no hidden row leaking.
    expect(collected).toEqual(visible)
  })

  it('hides a private child and parent from the detail relationship links', async () => {
    const viewer = await makeUser('sv-rel', 'collaborator')
    const other = await makeUser('sv-rel-other', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    const parent = await seedSessionMeta(prisma, `s-parent-${randomUUID()}`, agentId, {})
    const visibleChild = await seedSessionMeta(prisma, `s-child-ok-${randomUUID()}`, agentId, {
      parentSessionId: parent
    })
    const hiddenChild = await seedSessionMeta(prisma, `s-child-hidden-${randomUUID()}`, agentId, {
      parentSessionId: parent,
      visibility: 'private',
      ownerIdentity: `user:${other}`
    })

    const body = (await appAs(viewer).app.inject({ method: 'GET', url: `${ORG}/sessions/${parent}` })).json() as {
      childSessions: Array<{ id: string }>
    }
    expect(body.childSessions.map((c) => c.id)).toEqual([visibleChild])
    expect(body.childSessions.map((c) => c.id)).not.toContain(hiddenChild)
  })
})

describe('session visibility — PUT /sessions/:id/visibility (§4.3)', () => {
  it('lets the recorded owner pull an org session private and publish it back', async () => {
    const initiator = await makeUser('sv-put-owner', 'collaborator')
    const orgOwner = await makeUser('sv-put-admin', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const session = await seedSessionMeta(prisma, `s-put-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${initiator}`
    })

    // The initiator of an `org` channel session may pull it private…
    const initiatorApp = appAs(initiator)
    const res = await initiatorApp.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'private' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: session, visibility: 'private', visibilityRev: 1 })

    // …after which even an org owner cannot reach it (no view ⇒ no reclassify;
    // 404, never 403 — no existence oracle)…
    const denied = await appAs(orgOwner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'org' }
    })
    expect(denied.statusCode).toBe(404)

    // …and only the owner themselves may publish it back (widening is explicit,
    // never cascaded).
    const back = await initiatorApp.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'org' }
    })
    expect(back.statusCode).toBe(200)
    expect(back.json()).toMatchObject({ visibility: 'org', visibilityRev: 2 })
  })

  it('403s a member who can see the session but does not own it, and 404s one who cannot', async () => {
    const initiator = await makeUser('sv-put-init', 'collaborator')
    const bystander = await makeUser('sv-put-bystander', 'collaborator')
    const orgOwner = await makeUser('sv-put-role-admin', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    const orgSession = await seedSessionMeta(prisma, `s-put-org-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${initiator}`
    })
    const privateSession = await seedSessionMeta(prisma, `s-put-priv-${randomUUID()}`, agentId, {
      visibility: 'private',
      ownerIdentity: `user:${initiator}`
    })

    const app = appAs(bystander)
    // Visible but not theirs ⇒ 403.
    expect(
      (
        await app.app.inject({
          method: 'PUT',
          url: `${ORG}/sessions/${orgSession}/visibility`,
          payload: { visibility: 'private' }
        })
      ).statusCode
    ).toBe(403)
    // The org-owner ROLE grants nothing either: pulling someone's published
    // session back to private would override the owner's own decision.
    const asOrgOwner = await appAs(orgOwner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${orgSession}/visibility`,
      payload: { visibility: 'private' }
    })
    expect(asOrgOwner.statusCode).toBe(403)
    expect((await prisma.sessionMeta.findUnique({ where: { id: orgSession } }))?.visibility).toBe('org')
    // Invisible ⇒ 404, never 403: no existence oracle.
    expect(
      (
        await app.app.inject({
          method: 'PUT',
          url: `${ORG}/sessions/${privateSession}/visibility`,
          payload: { visibility: 'org' }
        })
      ).statusCode
    ).toBe(404)
  })

  it('refuses a former owner’s widen queued behind a concurrent re-owning tighten', async () => {
    const initiator = await makeUser('sv-queued-init', 'collaborator')
    const newOwner = await makeUser('sv-queued-newowner', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const session = await seedSessionMeta(prisma, `s-queued-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${initiator}`
    })

    // A concurrent tighten (as an ancestor cascade would) re-owns the row but
    // does NOT commit yet, so the former owner's PUT pre-reads the
    // still-committed `org` row under their identity, passes the view gate and
    // the unlocked authorization, and queues on `setVisibility`'s FOR UPDATE —
    // the exact TOCTOU window the locked-row re-check exists for.
    let lockTaken!: () => void
    const lockHeld = new Promise<void>((resolve) => (lockTaken = resolve))
    let commitTighten!: () => void
    const tightenHeld = new Promise<void>((resolve) => (commitTighten = resolve))
    const tighten = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE "session_meta" SET
            "visibility" = 'private'::"SessionVisibility",
            "ownerIdentity" = ${`user:${newOwner}`},
            "visibilitySource" = 'inherited'::"VisibilitySource",
            "visibilityRev" = "visibilityRev" + 1
          WHERE "id" = ${session}`
        lockTaken()
        await tightenHeld
      },
      { timeout: 20_000 }
    )
    await lockHeld

    const queuedWiden = appAs(initiator).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'org' }
    })
    // Only commit the tighten once the PUT is provably parked on the row lock —
    // i.e. it already passed its unlocked pre-read against the `org` row.
    for (let i = 0; ; i++) {
      const waiters = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
      if ((waiters[0]?.n ?? 0) > 0) break
      if (i > 400) throw new Error('the queued PUT never blocked on the row lock')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    commitTighten()
    await tighten

    // The lock-time re-check sees a private row owned by someone else: the
    // former owner no longer matches, 403, and the session stays private —
    // the queued request cannot reopen it.
    expect((await queuedWiden).statusCode).toBe(403)
    expect((await prisma.sessionMeta.findUnique({ where: { id: session } }))?.visibility).toBe('private')
  })

  it('reports `applied` when no daemon can ever ack the change', async () => {
    const owner = await makeUser('sv-state', 'owner')
    const agentId = await seedAgent(prisma, randomUUID()) // unplaced: no daemon
    const session = await seedSessionMeta(prisma, `s-state-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}` // re-classification is owner-only, role grants nothing
    })

    const res = await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${session}/visibility`,
      payload: { visibility: 'private' }
    })
    expect(res.json()).toMatchObject({ state: 'applied' })
  })
})

describe('session visibility — §5.1 daemon-ack cutover', () => {
  // The pending→applied decision itself (which needs a live, feature-advertising
  // daemon connection) is unit-tested in src/orchestrator/visibilityPush.test.ts;
  // here we pin the durable half: the revision it compares against.
  it('bumps the revision on every change and never lowers the ack watermark', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const session = await seedSessionMeta(prisma, `s-ack-${randomUUID()}`, agentId, { daemonId })
    const repo = new PgSessionRepo(prisma)

    // -1 is "never acknowledged" — distinct from an ack of revision 0, which is
    // a real revision for a session ingested and never re-classified.
    expect((await repo.get(SessionId(session)))?.visibilityAckedRev).toBe(-1)
    const { affected } = await repo.setVisibility(SessionId(session), 'private')
    expect(affected[0]).toMatchObject({ visibilityRev: 1, visibilityAckedRev: -1 })

    // At-least-once delivery means acks can arrive out of order; the watermark
    // is monotonic so a late one for an older revision cannot un-apply a change.
    await repo.recordVisibilityAck(SessionId(session), 0)
    expect((await repo.get(SessionId(session)))?.visibilityAckedRev).toBe(0)
    await repo.recordVisibilityAck(SessionId(session), 1)
    await repo.recordVisibilityAck(SessionId(session), 0)
    expect((await repo.get(SessionId(session)))?.visibilityAckedRev).toBe(1)

    // A no-op re-set neither bumps the revision nor re-opens the cutover.
    expect((await repo.setVisibility(SessionId(session), 'private')).affected).toEqual([])
    expect((await repo.get(SessionId(session)))?.visibilityRev).toBe(1)
  })

  it('replays an unacknowledged gate ahead of newer acknowledged ones', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    // An OLD session tightened while the daemon was offline: it must ride the
    // snapshot no matter how far past a newest-first cap it sits, or the daemon
    // keeps capturing against a stale `org` gate forever.
    const stale = await seedSessionMeta(prisma, `s-stale-${randomUUID()}`, agentId, {
      daemonId,
      lastActivityAt: new Date(Date.now() - 86_400_000)
    })
    await repo.setVisibility(SessionId(stale), 'private')
    const fresh = await seedSessionMeta(prisma, `s-fresh-${randomUUID()}`, agentId, {
      daemonId,
      lastActivityAt: new Date()
    })
    await repo.recordVisibilityAck(SessionId(fresh), 0)

    expect(await repo.countUnackedVisibility(daemonId)).toBe(1)
    const capped = await repo.visibilitySnapshotForDaemon(daemonId, 1)
    expect(capped).toEqual([{ sessionId: stale, visibility: 'private', visibilityRev: 1 }])
  })

  it('reports the cutover as pending while a DESCENDANT daemon is still behind', async () => {
    const owner = await makeUser('sv-subtree', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    const root = await seedSessionMeta(prisma, `s-sub-root-${randomUUID()}`, agentId, { daemonId })
    const child = await seedSessionMeta(prisma, `s-sub-child-${randomUUID()}`, agentId, {
      daemonId,
      parentSessionId: root
    })
    const { affected } = await repo.setVisibility(SessionId(root), 'private')
    expect(affected.map((a) => a.id).sort()).toEqual([child, root].sort())

    // Only the root's daemon acks. The child holds text copied from the root, so
    // the cutover is NOT complete — the detail view must keep saying pending.
    await repo.recordVisibilityAck(SessionId(root), 1)
    const subtree = await repo.visibilitySubtree(SessionId(root), 100)
    expect(subtree.map((r) => r.id).sort()).toEqual([child, root].sort())
    expect(subtree.find((r) => r.id === child)).toMatchObject({ visibilityAckedRev: -1, visibilityRev: 1 })
  })

  it('snapshots the gate state for one daemon, newest first', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const otherDaemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const older = await seedSessionMeta(prisma, `s-snap-old-${randomUUID()}`, agentId, {
      daemonId,
      lastActivityAt: new Date(Date.now() - 60_000)
    })
    const newer = await seedSessionMeta(prisma, `s-snap-new-${randomUUID()}`, agentId, {
      daemonId,
      visibility: 'private',
      lastActivityAt: new Date()
    })
    await seedSessionMeta(prisma, `s-snap-elsewhere-${randomUUID()}`, agentId, { daemonId: otherDaemonId })

    const snapshot = await new PgSessionRepo(prisma).visibilitySnapshotForDaemon(daemonId, 10)
    expect(snapshot).toEqual([
      { sessionId: newer, visibility: 'private', visibilityRev: 0 },
      { sessionId: older, visibility: 'org', visibilityRev: 0 }
    ])
  })
})

describe('session visibility — §4.5 inheritance and cascade', () => {
  it('tightening cascades transitively (explicit descendants included); widening never does', async () => {
    const owner = await makeUser('sv-cascade', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    // The root keeps the acting user's identity: once tightened, only its
    // identity-matched owner can still see it to widen it back.
    const root = await seedSessionMeta(prisma, `s-root-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}`
    })
    const child = await seedSessionMeta(prisma, `s-kid-${randomUUID()}`, agentId, { parentSessionId: root })
    const grandchild = await seedSessionMeta(prisma, `s-grandkid-${randomUUID()}`, agentId, {
      parentSessionId: child
    })
    // A descendant a human already re-classified: privacy still wins over it.
    await prisma.sessionMeta.update({ where: { id: grandchild }, data: { visibilitySource: 'explicit' } })

    const app = appAs(owner)
    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${root}/visibility`,
      payload: { visibility: 'private' }
    })
    for (const id of [root, child, grandchild]) {
      expect((await prisma.sessionMeta.findUnique({ where: { id } }))?.visibility).toBe('private')
    }

    // Widening the root leaves every descendant private — each is its own decision.
    await app.app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${root}/visibility`,
      payload: { visibility: 'org' }
    })
    expect((await prisma.sessionMeta.findUnique({ where: { id: root } }))?.visibility).toBe('org')
    for (const id of [child, grandchild]) {
      expect((await prisma.sessionMeta.findUnique({ where: { id } }))?.visibility).toBe('private')
    }
  })

  it('re-owns an already-private descendant, so its old owner loses the copied content', async () => {
    const owner = await makeUser('sv-reown', 'owner')
    const other = await makeUser('sv-reown-other', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })

    const root = await seedSessionMeta(prisma, `s-reown-root-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}`
    })
    // A child that is ALREADY private but owned by someone else. Its transcript
    // holds text delegated from the root, so tightening the root must hand it
    // the root's owner — leaving `other` on it keeps their access to that text.
    const child = await seedSessionMeta(prisma, `s-reown-child-${randomUUID()}`, agentId, {
      parentSessionId: root,
      visibility: 'private',
      ownerIdentity: `user:${other}`
    })

    await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/sessions/${root}/visibility`,
      payload: { visibility: 'private' }
    })

    expect(await prisma.sessionMeta.findUnique({ where: { id: child } })).toMatchObject({
      visibility: 'private',
      ownerIdentity: `user:${owner}`,
      visibilitySource: 'inherited'
    })
    // …and the former owner can no longer read it.
    expect((await appAs(other).app.inject({ method: 'GET', url: `${ORG}/sessions/${child}` })).statusCode).toBe(404)
  })

  it('re-authorizes against the locked row, so a revoked owner cannot still widen', async () => {
    const owner = await makeUser('sv-toctou', 'owner')
    const child_owner = await makeUser('sv-toctou-child', 'collaborator')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    const root = await seedSessionMeta(prisma, `s-toctou-root-${randomUUID()}`, agentId, {
      ownerIdentity: `user:${owner}`
    })
    const child = await seedSessionMeta(prisma, `s-toctou-child-${randomUUID()}`, agentId, {
      parentSessionId: root,
      visibility: 'private',
      ownerIdentity: `user:${child_owner}`
    })

    // The ancestor cascade re-owns the child to the root's owner.
    await repo.setVisibility(SessionId(root), 'private')

    // The child's FORMER owner now tries to publish it. The route's own check
    // could have passed on a pre-cascade read; the lock-time re-check refuses.
    const denied = await repo.setVisibility(
      SessionId(child),
      'org',
      (row) => row.ownerIdentity === `user:${child_owner}`
    )
    expect(denied).toMatchObject({ forbidden: true, affected: [] })
    expect((await repo.get(SessionId(child)))?.visibility).toBe('private')
  })

  it('settles an out-of-order child once, and never over a human decision', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const parentId = `s-late-parent-${randomUUID()}`

    // The child's milestone arrives first: no parent row to inherit from yet.
    const child = await repo.recordMilestone({
      sessionId: SessionId(`s-early-child-${randomUUID()}`),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { inherit: true },
      at: new Date()
    })
    expect(child.session).toMatchObject({ visibility: 'private', visibilitySource: 'inherited_pending' })

    // A second pending child that an org owner re-classifies before settlement.
    const pinned = await repo.recordMilestone({
      sessionId: SessionId(`s-pinned-child-${randomUUID()}`),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { inherit: true },
      at: new Date()
    })
    await repo.setVisibility(pinned.session!.id, 'org')

    // Now the parent lands as an org channel session.
    const parent = await repo.recordMilestone({
      sessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { visibility: 'org', ownerIdentity: 'slack:T1:U1', source: 'default' },
      at: new Date()
    })

    // The still-pending child settles from the parent, exactly once…
    expect(parent.settled.map((s) => s.id)).toEqual([child.session!.id])
    const settled = await prisma.sessionMeta.findUnique({ where: { id: child.session!.id } })
    expect(settled).toMatchObject({ visibility: 'org', ownerIdentity: 'slack:T1:U1', visibilitySource: 'inherited' })
    // …and the human decision is untouched (still `explicit`, not re-settled).
    const untouched = await prisma.sessionMeta.findUnique({ where: { id: pinned.session!.id } })
    expect(untouched).toMatchObject({ visibility: 'org', visibilitySource: 'explicit' })
  })

  it('settles a whole chain that arrived root-last, not just its first level', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const rootId = `s-chain-root-${randomUUID()}`
    const childId = `s-chain-child-${randomUUID()}`
    const grandchildId = `s-chain-grandchild-${randomUUID()}`

    // Deepest first: each arrival's parent is missing, or present but itself
    // still pending — either way the row must stay pending, or the settlement
    // scan (which matches only `inherited_pending`) would skip it forever.
    for (const [id, parent] of [
      [grandchildId, childId],
      [childId, rootId]
    ] as const) {
      const r = await repo.recordMilestone({
        sessionId: SessionId(id),
        parentSessionId: SessionId(parent),
        agentId,
        phase: 'start',
        classification: { inherit: true },
        at: new Date()
      })
      expect(r.session).toMatchObject({ visibility: 'private', visibilitySource: 'inherited_pending' })
    }

    const root = await repo.recordMilestone({
      sessionId: SessionId(rootId),
      agentId,
      phase: 'start',
      classification: { visibility: 'org', ownerIdentity: 'slack:T1:U7', source: 'default' },
      at: new Date()
    })

    // Both levels settle, and both are reported so each gets a §5.1 gate push.
    expect(root.settled.map((s) => s.id).sort()).toEqual([childId, grandchildId].sort())
    for (const id of [childId, grandchildId]) {
      expect(await prisma.sessionMeta.findUnique({ where: { id } })).toMatchObject({
        visibility: 'org',
        ownerIdentity: 'slack:T1:U7',
        visibilitySource: 'inherited'
      })
    }
  })

  it('inherits a private parent at ingest, so a delegated prompt is never org-visible', async () => {
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)

    const parentId = `s-dm-parent-${randomUUID()}`
    await repo.recordMilestone({
      sessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { visibility: 'private', ownerIdentity: 'user:u-1', source: 'default' },
      at: new Date()
    })
    const child = await repo.recordMilestone({
      sessionId: SessionId(`s-dm-child-${randomUUID()}`),
      parentSessionId: SessionId(parentId),
      agentId,
      phase: 'start',
      classification: { inherit: true },
      at: new Date()
    })
    expect(child.session).toMatchObject({
      visibility: 'private',
      ownerIdentity: 'user:u-1',
      visibilitySource: 'inherited'
    })
  })

  it('never leaves an org-visible descendant of a private parent, in either commit order', async () => {
    const owner = await makeUser('sv-race', 'owner')
    const daemonId = await seedDaemon(prisma, randomUUID())
    const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
    const repo = new PgSessionRepo(prisma)
    const app = appAs(owner)

    for (const childFirst of [true, false]) {
      const rootId = `s-race-root-${randomUUID()}`
      // The root's recorded owner is the acting user: the §4.3 PUT below is
      // owner-only (roles grant nothing), and this test is about the cascade.
      await repo.recordMilestone({
        sessionId: SessionId(rootId),
        agentId,
        phase: 'start',
        classification: { visibility: 'org', ownerIdentity: `user:${owner}`, source: 'default' },
        at: new Date()
      })
      const childId = `s-race-child-${randomUUID()}`
      const grandchildId = `s-race-grandchild-${randomUUID()}`
      await repo.recordMilestone({
        sessionId: SessionId(childId),
        parentSessionId: SessionId(rootId),
        agentId,
        phase: 'start',
        classification: { inherit: true },
        at: new Date()
      })

      // A grandchild ingest racing the ancestor's tighten — the depth-2 case the
      // lock-then-scan-to-fixpoint cascade exists for.
      const tighten = app.app.inject({
        method: 'PUT',
        url: `${ORG}/sessions/${rootId}/visibility`,
        payload: { visibility: 'private' }
      })
      const insertGrandchild = repo.recordMilestone({
        sessionId: SessionId(grandchildId),
        parentSessionId: SessionId(childId),
        agentId,
        phase: 'start',
        classification: { inherit: true },
        at: new Date()
      })
      await (childFirst ? Promise.all([insertGrandchild, tighten]) : Promise.all([tighten, insertGrandchild]))

      for (const id of [rootId, childId, grandchildId]) {
        const row = await prisma.sessionMeta.findUnique({ where: { id } })
        expect({ id, visibility: row?.visibility }).toEqual({ id, visibility: 'private' })
      }
    }
  })
})
