// Managed computer quotas, metering and egress per organization over real Postgres (computer-use.md §15.4, §15.5).
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgComputerRepo, PgComputerUsageRepo } from '../../src/persistence/index.js'
import { ComputerPlan } from '../../src/registry/computerPlan.js'
import { DEFAULT_COMPUTER_PLAN, loadComputerPlanConfig } from '../../src/computer-plan/config.js'
import type { SecretCipher } from '../../src/secrets/cipher.js'
import { managedComputerPolicy } from '../../src/domain/computerPool.js'
import { systemClock } from '../../src/domain/clock.js'
import { ComputerId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../src/config/defaults.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

/** Seals visibly, so a test sees that only the sealed form reaches the row. */
class PrefixCipher implements SecretCipher {
  async seal(plaintext: string): Promise<string> {
    return `sealed:${plaintext}`
  }
  async open(stored: string): Promise<string> {
    return stored.replace(/^sealed:/, '')
  }
}

const apps: HttpApp[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()))
})

function plan(over: Partial<typeof DEFAULT_COMPUTER_PLAN> = {}) {
  const repo = new PgComputerUsageRepo(prisma)
  return {
    repo,
    plan: new ComputerPlan(repo, new PrefixCipher(), systemClock, { ...DEFAULT_COMPUTER_PLAN, ...over })
  }
}

function consoleWith(p: ComputerPlan): HttpApp {
  const app = buildHttpApp(prisma, {}, undefined, undefined, { computerPlan: p })
  apps.push(app)
  return app
}

async function managed(allocation: 'manual' | 'per-agent' = 'manual'): Promise<string> {
  const id = ComputerId(randomUUID())
  await new PgComputerRepo(prisma).createManaged({
    id,
    orgId: OrgId(DEFAULT_ORG_ID),
    name: 'Desk',
    ownerUserId: DEFAULT_OWNER_ID,
    allocation,
    policy: managedComputerPolicy(DEFAULT_OWNER_ID),
    agentAccess: { mode: 'none', agents: [] },
    now: new Date()
  })
  return id
}

describe('managed computer plan', () => {
  it('parses AC_COMPUTER_PLAN over the built-in defaults, and refuses a malformed one', () => {
    expect(loadComputerPlanConfig({})).toEqual(DEFAULT_COMPUTER_PLAN)
    const doc = loadComputerPlanConfig({
      AC_COMPUTER_PLAN: JSON.stringify({ version: 1, quotas: { desktops: null, viewers: 9 }, volumeGib: 20 })
    })
    expect(doc.quotas).toMatchObject({ desktops: null, viewers: 9, runningDesktops: 3 })
    expect(doc.volumeGib).toBe(20)
    expect(doc.egress.orgProxy).toBe(true)
    expect(() => loadComputerPlanConfig({ AC_COMPUTER_PLAN: '{"version":1,"quotas":{"desktop":1}}' })).toThrow(
      /AC_COMPUTER_PLAN/
    )
  })

  it('meters each interval once even when two sweeps race, and splits it at UTC midnight', async () => {
    const { repo } = plan()
    const id = await managed()
    const since = new Date('2026-10-20T23:50:00.000Z')
    const to = new Date('2026-10-21T00:10:00.000Z')
    const accrual = {
      computerId: id,
      orgId: DEFAULT_ORG_ID,
      allocation: 'manual',
      meteredAt: null,
      since,
      to,
      state: 'running' as const,
      volumeGib: 5
    }
    const [a, b] = await Promise.all([repo.accrue(accrual), repo.accrue(accrual)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    const usage = await repo.usage(DEFAULT_ORG_ID, { from: since, to: new Date('2026-10-22T00:00:00.000Z') })
    expect(usage.days).toEqual([
      expect.objectContaining({ day: '2026-10-20', runningSeconds: 600, volumeGibSeconds: 3000 }),
      expect.objectContaining({ day: '2026-10-21', runningSeconds: 600 })
    ])
    // The next accrual starts where this one stopped and bills its new phase.
    expect(
      await repo.accrue({ ...accrual, meteredAt: to, to: new Date(to.getTime() + 60_000), state: 'sleeping' })
    ).toBe(true)
    const after = await repo.usage(DEFAULT_ORG_ID, { from: since, to: new Date('2026-10-22T00:00:00.000Z') })
    expect(after.totals).toEqual({
      runningSeconds: 1200,
      sleepingSeconds: 60,
      volumeGibSeconds: 6300,
      relayedBytes: 0
    })
  })

  it('counts relayed bytes for known Computers only, and viewers until their tokens lapse', async () => {
    const { repo, plan: p } = plan({ quotas: { ...DEFAULT_COMPUTER_PLAN.quotas, viewersPerComputer: 1 } })
    const id = await managed()
    const now = new Date()
    expect(
      await repo.addRelayed(
        [
          { computerId: id, bytes: 1000 },
          { computerId: id, bytes: 24 },
          { computerId: randomUUID(), bytes: 5 }
        ],
        now
      )
    ).toBe(1)
    const usage = await p.usage(DEFAULT_ORG_ID, {
      from: new Date(now.getTime() - 86_400_000),
      to: new Date(now.getTime() + 86_400_000)
    })
    expect(usage.computers).toEqual([expect.objectContaining({ computerId: id, relayedBytes: 1024, kind: 'managed' })])

    expect(await p.viewerRefusal(DEFAULT_ORG_ID, id, 'u1')).toBeNull()
    await p.viewerGranted(DEFAULT_ORG_ID, id, 'u1', new Date(now.getTime() + 120_000))
    // The same viewer renewing is not a second viewer; another one is.
    expect(await p.viewerRefusal(DEFAULT_ORG_ID, id, 'u1')).toBeNull()
    expect(await p.viewerRefusal(DEFAULT_ORG_ID, id, 'u2')).toMatchObject({ quota: 'viewersPerComputer' })
    await p.viewerGranted(DEFAULT_ORG_ID, id, 'u1', new Date(now.getTime() - 1))
    expect(await p.viewerRefusal(DEFAULT_ORG_ID, id, 'u2')).toBeNull()
    expect(await repo.reapViewers(new Date(now.getTime() + 1))).toBe(1)
  })

  it('shows quotas to members, lets only a deployment admin change them, and reports usage', async () => {
    const { plan: p } = plan()
    await managed()
    const app = consoleWith(p)
    const status = await app.app.inject({ method: 'GET', url: `${ORG}/computers/quotas` })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      limits: { runningDesktops: 3, desktops: 10 },
      override: null,
      used: { desktops: 1, runningDesktops: 1, storageGib: 5, modes: { manual: { desktops: 1 } } },
      canEdit: true
    })
    const set = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/quotas`,
      payload: { override: { desktops: 1, modes: { manual: { runningDesktops: 0 } } } }
    })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ limits: { desktops: 1, modes: { manual: { runningDesktops: 0 } } } })
    expect(await p.desktopRefusal(DEFAULT_ORG_ID, { allocation: 'manual', adding: false })).toMatchObject({
      quota: 'runningDesktops'
    })
    const bad = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/quotas`,
      payload: { override: { foo: 1 } }
    })
    expect(bad.statusCode).toBe(400)
    const cleared = await app.app.inject({ method: 'PUT', url: `${ORG}/computers/quotas`, payload: { override: null } })
    expect(cleared.json()).toMatchObject({ override: null, limits: { desktops: 10 } })

    const usage = await app.app.inject({
      method: 'GET',
      url: `${ORG}/usage/computers?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`
    })
    expect(usage.statusCode).toBe(200)
    expect(usage.json()).toMatchObject({ totals: { runningSeconds: 0 }, screenshots: { stored: { count: 0 } } })
  })

  it('keeps an organization’s proxy password sealed, never shows it, and drops it for another proxy', async () => {
    const { plan: p } = plan()
    const pushed: unknown[] = []
    p.bindChannels({ pushEgress: (orgId, egress) => pushed.push({ orgId, egress }) })
    const app = consoleWith(p)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/computers/egress` })).json()).toMatchObject({
      mode: 'deployment',
      passwordSet: false,
      orgProxyAllowed: true
    })
    const set = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/egress`,
      payload: { mode: 'proxy', url: 'http://proxy.example.com:3128', username: 'acme', password: 'pw-1' }
    })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toEqual({
      mode: 'proxy',
      url: 'http://proxy.example.com:3128',
      username: 'acme',
      passwordSet: true,
      orgProxyAllowed: true,
      description: null,
      canEdit: true
    })
    expect(await prisma.computerOrgSettings.findUnique({ where: { orgId: DEFAULT_ORG_ID } })).toMatchObject({
      egressProxyPassword: 'sealed:pw-1'
    })
    const desktop = { mode: 'proxy', url: 'http://proxy.example.com:3128', username: 'acme', password: 'pw-1' }
    expect(await p.egressFor(DEFAULT_ORG_ID)).toEqual(desktop)
    expect(pushed).toEqual([{ orgId: DEFAULT_ORG_ID, egress: desktop }])
    // The same proxy keeps its password; another one never receives it.
    await p.setEgress(DEFAULT_ORG_ID, { mode: 'proxy', url: 'http://proxy.example.com:3128', username: 'acme' })
    expect(await p.egressFor(DEFAULT_ORG_ID)).toMatchObject({ password: 'pw-1' })
    await p.setEgress(DEFAULT_ORG_ID, { mode: 'proxy', url: 'https://other.example.com:8443' })
    expect(await p.egressFor(DEFAULT_ORG_ID)).toEqual({ mode: 'proxy', url: 'https://other.example.com:8443' })
    const withCredentials = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/egress`,
      payload: { mode: 'proxy', url: 'http://user:pw@proxy.example.com:3128' }
    })
    expect(withCredentials.statusCode).toBe(400)
    await app.app.inject({ method: 'PUT', url: `${ORG}/computers/egress`, payload: { mode: 'deployment' } })
    expect(await p.egressFor(DEFAULT_ORG_ID)).toEqual({ mode: 'direct' })
  })

  it('refuses an organization proxy where the deployment allows none', async () => {
    const { plan: p } = plan({ egress: { orgProxy: false, description: 'Data-centre egress in us-west-2' } })
    const app = consoleWith(p)
    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/egress`,
      payload: { mode: 'proxy', url: 'http://proxy.example.com:3128' }
    })
    expect(res.statusCode).toBe(403)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/computers/egress` })).json()).toMatchObject({
      orgProxyAllowed: false,
      description: 'Data-centre egress in us-west-2'
    })
  })
})
