/**
 * `/member-sets` — an organization's own member sets (docs/designs/daemon-groups.md §2, §3).
 *
 * Two things are load-bearing here and neither is CRUD. First, the route is fenced on the path
 * org and the install-wide pool is not this organization's to see or touch. Second, membership
 * moves runtime authority, so each direction is admitted only from a state where nothing is
 * taken away from a running machine: a daemon with pinned agents may not join, and a daemon
 * holding a live duty lease may not leave.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { poolSetId } from '../fakes/member-set.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GROUP = '99999999-9999-4999-8999-999999999991'

interface SetBody {
  setId: string
  name: string
  memberDaemonIds: string[]
}

describe('member sets — CRUD is org-fenced (real Postgres)', () => {
  it('creates, lists, renames and deletes, and never sees the install-wide pool', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = await app.inject({ method: 'POST', url: `${ORG}/member-sets`, payload: { name: 'lab' } })
      expect(created.statusCode).toBe(201)
      const set = created.json() as SetBody
      expect(set).toMatchObject({ name: 'lab', memberDaemonIds: [] })

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

  it('refuses a daemon that still has agents pinned to it — they would become unservable', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      await seedDaemon(prisma, DAEMON)
      await seedAgent(prisma, AGENT, { daemonId: DAEMON })
      const setId = await withSet(app)

      const res = await app.inject({ method: 'PUT', url: `${ORG}/member-sets/${setId}/members/${DAEMON}` })
      expect(res.statusCode).toBe(409)
      expect(await prisma.memberSetMember.count()).toBe(0)
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
