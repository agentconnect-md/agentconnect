/**
 * `PgOrgRepo.orgTelemetry` — the read behind the per-org gauges
 * (`src/observability/org-metrics.ts`).
 *
 * The gauges' own logic is unit-tested; what needs a real database is the query: that the three
 * tables are attributed to the right org, that an install-wide pool member (no org) is counted for
 * nobody, and that the session windows cut at the caller's clock rather than the database's.
 */
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { OrgTelemetryRow } from '../../src/persistence/ports.js'

const NOW = new Date('2026-06-01T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// Preset agents would add rows this test does not control, so the repo is built without them.
const repo = () => new PgOrgRepo(prisma, false)

const byId = (rows: OrgTelemetryRow[], orgId: string) => rows.find((r) => r.orgId === orgId)!

describe('orgTelemetry', () => {
  it('attributes daemons, agents and sessions to their own org', async () => {
    const other = await prisma.org.create({ data: { slug: 'other-org' } })
    await seedDaemon(prisma, '11111111-1111-4111-8111-111111111111')
    await seedAgent(prisma, '22222222-2222-4222-8222-222222222222')
    await seedAgent(prisma, '33333333-3333-4333-8333-333333333333', { name: 'second' })
    await seedAgent(prisma, '44444444-4444-4444-8444-444444444444', { orgId: other.id, name: 'theirs' })
    await seedSessionMeta(prisma, 's-1', '22222222-2222-4222-8222-222222222222', { startedAt: ago(2 * HOUR) })
    await seedSessionMeta(prisma, 's-2', '44444444-4444-4444-8444-444444444444', {
      orgId: other.id,
      startedAt: ago(2 * HOUR)
    })

    const rows = await repo().orgTelemetry(NOW)

    expect(byId(rows, DEFAULT_ORG_ID)).toMatchObject({ daemons: 1, agents: 2, sessionsTotal: 1 })
    expect(byId(rows, other.id)).toMatchObject({ daemons: 0, agents: 1, sessionsTotal: 1 })
  })

  // The counts have to survive a rename, so a row is keyed by id; the slug is read beside it and is
  // meant to follow the rename — that is the whole job of the info series it feeds.
  it('keys a row by id while the slug follows a rename', async () => {
    const org = await prisma.org.create({ data: { slug: 'before-rename', name: 'Display Name' } })

    const before = await repo().orgTelemetry(NOW)
    await prisma.org.update({ where: { id: org.id }, data: { slug: 'after-rename' } })
    const after = await repo().orgTelemetry(NOW)

    expect(byId(before, org.id)).toMatchObject({ slug: 'before-rename' })
    expect(byId(after, org.id)).toMatchObject({ slug: 'after-rename' })
  })

  // The display name is free-form text a user typed; nothing downstream may export it, so the read
  // must not hand it out in the first place.
  it('does not read the org display name at all', async () => {
    const org = await prisma.org.create({ data: { slug: 'named-org', name: 'Display Name' } })

    expect(Object.keys(byId(await repo().orgTelemetry(NOW), org.id))).not.toContain('name')
  })

  // An org running entirely on the install-wide pool reads zero daemons — the member is shared by
  // every org and owned by none, so crediting it to one would overstate that org's fleet.
  it('counts an org-less pool member for nobody', async () => {
    await prisma.daemon.create({ data: { id: '55555555-5555-4555-8555-555555555555', orgId: null } })

    const rows = await repo().orgTelemetry(NOW)

    expect(rows.every((r) => r.daemons === 0)).toBe(true)
  })

  it('splits sessions by start time, at the clock it was given', async () => {
    await seedAgent(prisma, '22222222-2222-4222-8222-222222222222')
    const agent = '22222222-2222-4222-8222-222222222222'
    await seedSessionMeta(prisma, 'fresh', agent, { startedAt: ago(2 * HOUR) })
    await seedSessionMeta(prisma, 'this-month', agent, { startedAt: ago(10 * DAY) })
    await seedSessionMeta(prisma, 'ancient', agent, { startedAt: ago(90 * DAY) })

    const row = byId(await repo().orgTelemetry(NOW), DEFAULT_ORG_ID)

    // The total is cumulative over an unpruned table; the windows are how many BEGAN inside them.
    expect(row).toMatchObject({ sessionsTotal: 3, sessions30d: 2, sessions24h: 1 })

    // The windows move with the caller's clock, not the database's — 40 days on and only the
    // lifetime total survives, which is what makes an idle org legible on the dashboard.
    const later = byId(await repo().orgTelemetry(new Date(NOW.getTime() + 40 * DAY)), DEFAULT_ORG_ID)
    expect(later).toMatchObject({ sessionsTotal: 3, sessions30d: 0, sessions24h: 0 })
  })

  // A series that vanishes on its way to zero is invisible on a dashboard: an org that removed its
  // last daemon would look like an org that never existed.
  it('reports an org holding nothing at all, as zeros', async () => {
    const empty = await prisma.org.create({ data: { slug: 'empty-org' } })

    const rows = await repo().orgTelemetry(NOW)

    expect(byId(rows, empty.id)).toMatchObject({
      daemons: 0,
      agents: 0,
      sessionsTotal: 0,
      sessions30d: 0,
      sessions24h: 0
    })
  })
})
