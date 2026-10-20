// Computer use audit (computer-use.md §8.2): desktop-reported entries, stored without typed text, queried per Computer by its owner.
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { FakeClock } from '../fakes/fake-clock.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgComputerAuditRepo } from '../../src/persistence/repositories/computer-audit.repo.js'
import { ComputerAuditLog, COMPUTER_AUDIT_RETENTION_MS } from '../../src/registry/computerAuditLog.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REGISTER = '/api/v1/computers/register'
const AGENT = '00000000-0000-4000-8000-0000000000bb'
const T0 = Date.parse('2026-10-21T10:00:00.000Z')

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function appAs(userId: string = DEFAULT_OWNER_ID): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId, PUBLIC_CP_URL: 'https://cp.example.com' })
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

const entry = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  at: new Date(T0 + n * 1000).toISOString(),
  tool: 'computer_click',
  client: `${AGENT}/sess-1`,
  agentId: AGENT,
  sessionId: 'sess-1',
  outcome: 'ok' as const,
  approval: 'not_required' as const,
  args: { x: n, y: 2 },
  ms: 12,
  ...extra
})

type Page = { entries: Array<Record<string, unknown>>; nextCursor: string | null }

describe('computer audit', () => {
  it('stores a batch once, keeps typed text by length only, and pages newest first for the owner', async () => {
    const dana = await makeUser('audit-dana', 'collaborator')
    const computerId = await register(appAs(dana))
    const log = new ComputerAuditLog(new PgComputerAuditRepo(prisma), new FakeClock(T0))
    const typed = entry(3, { tool: 'computer_type', args: { text: 'hunter2' }, approval: 'allowed' })
    const batch = [entry(1), entry(2), typed]
    expect(await log.record(DEFAULT_ORG_ID, computerId, batch)).toBe(3)
    // A batch resent after a lost ack adds nothing.
    expect(await log.record(DEFAULT_ORG_ID, computerId, batch)).toBe(0)

    const row = await prisma.computerAudit.findFirstOrThrow({ where: { computerId, tool: 'computer_type' } })
    expect(row.args).toEqual({})
    expect(row.textLength).toBe(7)
    expect(JSON.stringify(row)).not.toContain('hunter2')

    const app = appAs(dana)
    const first = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}/audit?limit=2` })
    expect(first.statusCode).toBe(200)
    const page = first.json() as Page
    expect(page.entries.map((e) => e.tool)).toEqual(['computer_type', 'computer_click'])
    expect(page.entries[0]).toMatchObject({ agentId: AGENT, sessionId: 'sess-1', approval: 'allowed', textLength: 7 })
    const rest = (
      await app.app.inject({
        method: 'GET',
        url: `${ORG}/computers/${computerId}/audit?limit=2&cursor=${page.nextCursor}`
      })
    ).json() as Page
    expect(rest.entries.map((e) => e.args)).toEqual([{ x: 1, y: 2 }])
    expect(rest.nextCursor).toBeNull()

    const bySession = (
      await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}/audit?sessionId=other` })
    ).json() as Page
    expect(bySession.entries).toEqual([])
  })

  it('is the owner’s to read: an organization owner who sees the desktop gets 403', async () => {
    const dana = await makeUser('audit-owner-dana', 'collaborator')
    const computerId = await register(appAs(dana))
    const res = await appAs().app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}/audit` })
    expect(res.statusCode).toBe(403)
    const bad = await appAs(dana).app.inject({
      method: 'GET',
      url: `${ORG}/computers/${computerId}/audit?cursor=not-a-cursor`
    })
    expect(bad.statusCode).toBe(400)
  })

  it('drops entries past the retention window as new ones arrive', async () => {
    const computerId = await register(appAs())
    const clock = new FakeClock(T0)
    const log = new ComputerAuditLog(new PgComputerAuditRepo(prisma), clock)
    await log.record(DEFAULT_ORG_ID, computerId, [entry(1)])
    clock.advance(COMPUTER_AUDIT_RETENTION_MS + 60_000)
    await log.record(DEFAULT_ORG_ID, computerId, [
      entry(2, { at: new Date(T0 + COMPUTER_AUDIT_RETENTION_MS + 60_000).toISOString() })
    ])
    const rows = await prisma.computerAudit.findMany({ where: { computerId } })
    expect(rows.map((r) => r.args)).toEqual([{ x: 2, y: 2 }])
  })
})
