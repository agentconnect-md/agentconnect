/**
 * `/member-sets` — an organization's own member sets (docs/designs/daemon-groups.md §2, §3).
 *
 * Two things are load-bearing here and neither is CRUD. First, the route is fenced on the path
 * org and the install-wide pool is not this organization's to see or touch. Second, the two
 * directions are asymmetric: joining takes nothing away — a pinned agent stays pinned, because a
 * `daemon` placement is eligible for exactly that machine — while leaving is refused while the
 * machine still holds a live duty lease.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { poolSetId } from '../fakes/member-set.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GROUP = '99999999-9999-4999-8999-999999999991'

interface SetBody {
  setId: string
  name: string
  memberDaemonIds: string[]
  agentCount: number
  spreadSessions: boolean
}

describe('member sets — CRUD is org-fenced (real Postgres)', () => {
  it('creates, lists, renames and deletes, and never sees the install-wide pool', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = await app.inject({ method: 'POST', url: `${ORG}/member-sets`, payload: { name: 'lab' } })
      expect(created.statusCode).toBe(201)
      const set = created.json() as SetBody
      expect(set).toMatchObject({ name: 'lab', memberDaemonIds: [], agentCount: 0 })

      // The pool exists, and it is not listed: it belongs to no organization.
      const pool = await poolSetId(prisma)
      const listed = (await app.inject({ method: 'GET', url: `${ORG}/member-sets` })).json() as SetBody[]
      expect(listed.map((s) => s.setId)).toEqual([set.setId])
      expect(
        await app.inject({ method: 'PATCH', url: `${ORG}/member-sets/${pool}`, payload: { name: 'mine' } })
      ).toMatchObject({ statusCode: 404 })

      const renamed = await app.inject({
        method: 'PATCH',
        url: `${ORG}/member-sets/${set.setId}`,
        payload: { name: 'lab-2' }
      })
      expect((renamed.json() as SetBody).name).toBe('lab-2')

      expect((await app.inject({ method: 'DELETE', url: `${ORG}/member-sets/${set.setId}` })).statusCode).toBe(204)
      expect(((await app.inject({ method: 'GET', url: `${ORG}/member-sets` })).json() as SetBody[]).length).toBe(0)
    } finally {
      await close()
    }
  })

  it('reports what is placed on the set — the count the console shows beside the pool and a cluster', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const set = (
        await app.inject({ method: 'POST', url: `${ORG}/member-sets`, payload: { name: 'lab' } })
      ).json() as SetBody
      await seedAgent(prisma, AGENT, { setId: set.setId })

      const listed = (await app.inject({ method: 'GET', url: `${ORG}/member-sets` })).json() as SetBody[]
      expect(listed).toEqual([
        { setId: set.setId, name: 'lab', memberDaemonIds: [], agentCount: 1, spreadSessions: false }
      ])
    } finally {
      await close()
    }
  })

  it('spreads sessions only once someone turns the switch on, and a rename leaves it alone', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const set = (
        await app.inject({ method: 'POST', url: `${ORG}/member-sets`, payload: { name: 'lab' } })
      ).json() as SetBody
      // The group admin's consent is explicit: a new set spreads nothing.
      expect(set.spreadSessions).toBe(false)

      const url = `${ORG}/member-sets/${set.setId}/spread-sessions`
      const on = await app.inject({ method: 'PUT', url, payload: { enabled: true } })
      expect(on.statusCode).toBe(200)
      expect(on.json() as SetBody).toMatchObject({ setId: set.setId, spreadSessions: true })

      const renamed = await app.inject({
        method: 'PATCH',
        url: `${ORG}/member-sets/${set.setId}`,
        payload: { name: 'x' }
      })
      expect(renamed.json() as SetBody).toMatchObject({ name: 'x', spreadSessions: true })
      const listed = (await app.inject({ method: 'GET', url: `${ORG}/member-sets` })).json() as SetBody[]
      expect(listed.map((s) => s.spreadSessions)).toEqual([true])

      const off = await app.inject({ method: 'PUT', url, payload: { enabled: false } })
      expect((off.json() as SetBody).spreadSessions).toBe(false)
      expect((await app.inject({ method: 'PUT', url, payload: { enabled: 'yes' } })).statusCode).toBe(400)
    } finally {
      await close()
    }
  })

  it('keeps the switch off the install-wide pool, another organization’s set, and a viewer’s hands', async () => {
    const { app, close } = buildHttpApp(prisma)
    const other = await prisma.org.create({ data: { slug: `mset-${randomUUID().slice(0, 8)}` } })
    const theirs = await prisma.memberSet.create({ data: { id: randomUUID(), orgId: other.id, name: 'theirs' } })
    const pool = await poolSetId(prisma)
    try {
      for (const setId of [pool, theirs.id, randomUUID()]) {
        const refused = await app.inject({
          method: 'PUT',
          url: `${ORG}/member-sets/${setId}/spread-sessions`,
          payload: { enabled: true }
        })
        expect([setId, refused.statusCode]).toEqual([setId, 404])
      }
      expect(await prisma.memberSet.count({ where: { spreadSessions: true } })).toBe(0)
    } finally {
      await close()
    }

    // The same fence as renaming the set: a viewer reads the switch and cannot move it.
    const users = new PgUserRepo(prisma)
    const email = `mset-viewer-${randomUUID()}@example.test`
    const { userId } = await users.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'viewer')
    const mine = await prisma.memberSet.create({ data: { id: randomUUID(), orgId: DEFAULT_ORG_ID, name: 'mine' } })
    const viewer = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
    try {
      const refused = await viewer.app.inject({
        method: 'PUT',
        url: `${ORG}/member-sets/${mine.id}/spread-sessions`,
        payload: { enabled: true }
      })
      expect(refused.statusCode).toBe(403)
      expect(await prisma.memberSet.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({
        spreadSessions: false
      })
    } finally {
      await viewer.close()
    }
  })

  it('refuses to delete a set that still has members', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      await seedDaemon(prisma, DAEMON)
      const set = (
        await app.inject({ method: 'POST', url: `${ORG}/member-sets`, payload: { name: 'lab' } })
      ).json() as SetBody
      await app.inject({ method: 'PUT', url: `${ORG}/member-sets/${set.setId}/members/${DAEMON}` })

      expect((await app.inject({ method: 'DELETE', url: `${ORG}/member-sets/${set.setId}` })).statusCode).toBe(409)
    } finally {
      await close()
    }
  })
})

describe('member sets — the enrolment transitions (real Postgres)', () => {
  async function withSet(app: ReturnType<typeof buildHttpApp>['app']): Promise<string> {
    const set = (
      await app.inject({ method: 'POST', url: `${ORG}/member-sets`, payload: { name: 'lab' } })
    ).json() as SetBody
    return set.setId
  }

  it('enrolls a daemon with nothing pinned to it, and reports it on the daemon', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      await seedDaemon(prisma, DAEMON)
      const setId = await withSet(app)

      const joined = await app.inject({ method: 'PUT', url: `${ORG}/member-sets/${setId}/members/${DAEMON}` })
      expect(joined.statusCode).toBe(200)
      expect((joined.json() as SetBody).memberDaemonIds).toEqual([DAEMON])

      const daemons = (await app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as {
        daemonId: string
        memberSetId: string | null
      }[]
      expect(daemons.find((d) => d.daemonId === DAEMON)?.memberSetId).toBe(setId)
    } finally {
      await close()
    }
  })

  it('keeps the pinned agents on the machine, and lets nothing else hold them', async () => {
    // §3: a pin narrows to exactly one machine. The join is a membership row, not a transition —
    // the agent stays where it was and the machine stays its only eligible holder.
    const { app, close } = buildHttpApp(prisma)
    try {
      await seedDaemon(prisma, DAEMON)
      await seedAgent(prisma, AGENT, { daemonId: DAEMON })
      const setId = await withSet(app)

      const joined = await app.inject({ method: 'PUT', url: `${ORG}/member-sets/${setId}/members/${DAEMON}` })
      expect(joined.statusCode).toBe(200)
      expect((joined.json() as SetBody).memberDaemonIds).toEqual([DAEMON])
      expect(await prisma.agent.findUniqueOrThrow({ where: { id: AGENT } })).toMatchObject({
        placementKind: 'daemon',
        daemonId: DAEMON,
        setId: null
      })
      // And the set reports what is placed ON it, which is still nothing: the agent is on a
      // machine that happens to be a member, not on the group.
      const listed = (await app.inject({ method: 'GET', url: `${ORG}/member-sets` })).json() as SetBody[]
      expect(listed.find((s) => s.setId === setId)?.agentCount).toBe(0)
    } finally {
      await close()
    }
  })

  it('refuses a daemon of another organization', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const other = await prisma.org.create({ data: { slug: `mset-${randomUUID().slice(0, 8)}` } })
      const theirs = randomUUID()
      await prisma.daemon.create({ data: { id: theirs, orgId: other.id, maxAgents: 8, status: 'ready' } })
      const setId = await withSet(app)

      expect(
        (await app.inject({ method: 'PUT', url: `${ORG}/member-sets/${setId}/members/${theirs}` })).statusCode
      ).toBe(404)
    } finally {
      await close()
    }
  })

  it('refuses withdrawal while the daemon still holds a live duty lease', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      await seedDaemon(prisma, DAEMON)
      const setId = await withSet(app)
      await app.inject({ method: 'PUT', url: `${ORG}/member-sets/${setId}/members/${DAEMON}` })
      // A lease that has not lapsed is exactly "this machine may still be serving" — the state the
      // design's two-phase removal exists to avoid committing over.
      await prisma.dutyGroup.create({
        data: {
          id: GROUP,
          orgId: DEFAULT_ORG_ID,
          holder: DAEMON,
          term: 1n,
          expiresAt: new Date(Date.now() + 60_000)
        }
      })

      const refused = await app.inject({ method: 'DELETE', url: `${ORG}/member-sets/${setId}/members/${DAEMON}` })
      expect(refused.statusCode).toBe(409)

      // Once the lease has lapsed the daemon has provably self-fenced, and it may leave.
      await prisma.dutyGroup.update({ where: { id: GROUP }, data: { expiresAt: new Date(Date.now() - 1) } })
      const withdrawn = await app.inject({ method: 'DELETE', url: `${ORG}/member-sets/${setId}/members/${DAEMON}` })
      expect(withdrawn.statusCode).toBe(200)
      expect((withdrawn.json() as SetBody).memberDaemonIds).toEqual([])
    } finally {
      await close()
    }
  })
})
