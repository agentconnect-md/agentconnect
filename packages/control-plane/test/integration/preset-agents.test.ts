/**
 * Preset agents, M0 (docs/designs/preset-agents.md §3) — the org-creation seam,
 * the one-time backfill, the reserved slugs, and the deferred-runtime tolerance
 * of the existing routes.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { GENERAL_PRESET, PresetAgentBackfill, provisionPresetAgents } from '../../src/persistence/index.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { ensurePersonalOrg } from '../../src/persistence/repositories/user.repo.js'
import { ensureDefaultTenant } from '../../src/persistence/ensure-default-tenant.js'
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import { AgentId, DaemonId } from '../../src/domain/ids.js'

const silentLog = { info() {}, warn() {} }

interface AgentBody {
  id: string
  name: string
  displayName: string | null
  runtime: string | null
  daemonId: string | null
  icon: { kind: string; glyph?: string; color?: string } | null
}

describe('org-creation seam (POST /orgs)', () => {
  it('a new org is born with the agentconnect preset — unplaced, runtime deferred', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { slug: 'preset-org' } })
      expect(created.statusCode).toBe(201)
      const orgId = (created.json() as { id: string }).id

      const list = await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/agents` })
      expect(list.statusCode).toBe(200)
      const agents = list.json() as AgentBody[]
      expect(agents).toHaveLength(1)
      const preset = agents[0]!
      expect(preset.name).toBe('agentconnect')
      expect(preset.displayName).toBe('AgentConnect')
      expect(preset.runtime).toBeNull() // deferred exec config
      expect(preset.daemonId).toBeNull() // unplaced
      expect(preset.icon).toEqual(GENERAL_PRESET.icon) // fixed brand glyph, not random

      const row = await prisma.presetAgent.findUnique({
        where: { orgId_preset: { orgId, preset: 'general' } }
      })
      expect(row).toMatchObject({ agentId: preset.id, status: 'created', placementSettledAt: null })
    } finally {
      await close()
    }
  })

  it('deleting the preset settles it — the state row survives with the stamp', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { slug: 'del-org' } })
      const orgId = (created.json() as { id: string }).id
      const agents = (await (await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/agents` })).json()) as {
        id: string
      }[]

      const del = await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${orgId}/agents/${agents[0]!.id}` })
      expect(del.statusCode).toBe(204)

      const row = await prisma.presetAgent.findUnique({
        where: { orgId_preset: { orgId, preset: 'general' } }
      })
      expect(row?.agentId).toBeNull() // FK SetNull
      expect(row?.placementSettledAt).toBeInstanceOf(Date) // explicit opt-out settles
    } finally {
      await close()
    }
  })
})

describe('reserved agent slugs (§3.3)', () => {
  it.each(['agentconnect', 'agentconnect-assistant', 'agent-assistant', 'assistant'])(
    'POST /agents refuses the reserved slug %s',
    async (name) => {
      const { app, close } = buildHttpApp(prisma)
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
          payload: { name, runtime: 'claude' }
        })
        // The zod refine surfaces as the validator's generic 400 (same as the
        // reserved ORG slugs); the sibling below proves the slug is the reason.
        expect(res.statusCode).toBe(400)
        const sibling = await app.inject({
          method: 'POST',
          url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
          payload: { name: `${name}-2`, runtime: 'claude' }
        })
        expect(sibling.statusCode).toBe(201)
      } finally {
        await close()
      }
    }
  )
})

describe('one-time backfill', () => {
  it('provisions existing orgs, skips a slug collision permanently, and never resurrects', async () => {
    // Two pre-feature orgs: one clean, one that already owns the reserved name.
    const clean = await prisma.org.create({ data: { slug: `bf-clean-${randomUUID().slice(0, 8)}` } })
    const collided = await prisma.org.create({ data: { slug: `bf-collide-${randomUUID().slice(0, 8)}` } })
    const userAgent = randomUUID()
    await prisma.agent.create({
      data: { id: userAgent, orgId: collided.id, name: 'agentconnect', runtime: 'claude' }
    })

    const backfill = new PresetAgentBackfill(prisma, silentLog)
    const first = await backfill.run()
    // ≥: the truncated-per-test DB may hold other orgs (the seeded default).
    expect(first.provisioned).toBeGreaterThanOrEqual(1)
    expect(first.skipped).toBe(1)
    expect(first.failed).toBe(0)

    const cleanRow = await prisma.presetAgent.findUnique({
      where: { orgId_preset: { orgId: clean.id, preset: 'general' } }
    })
    expect(cleanRow?.status).toBe('created')
    const provisioned = await prisma.agent.findUnique({
      where: { orgId_name: { orgId: clean.id, name: 'agentconnect' } }
    })
    expect(provisioned?.runtime).toBeNull()
    expect(provisioned?.createdByUserId).toBeNull() // system write, no personal creator

    const collidedRow = await prisma.presetAgent.findUnique({
      where: { orgId_preset: { orgId: collided.id, preset: 'general' } }
    })
    expect(collidedRow).toMatchObject({ status: 'skipped', agentId: null })
    // The user's own agent is untouched (never renamed, never replaced).
    const kept = await prisma.agent.findUnique({ where: { id: userAgent } })
    expect(kept?.runtime).toBe('claude')

    // Delete the clean org's preset, run again: the state row stops resurrection.
    await new PgAgentRepo(prisma).delete(AgentId(provisioned!.id))
    const second = await backfill.run()
    expect(second.provisioned).toBe(0)
    expect(second.skipped).toBe(0)
    const stillGone = await prisma.agent.findUnique({
      where: { orgId_name: { orgId: clean.id, name: 'agentconnect' } }
    })
    expect(stillGone).toBeNull()
  })
})

/**
 * The JIT-signup path reaches the seam with the ROOT client, not a transaction —
 * so `ensurePersonalOrg` must open one itself. Without that, a crash after the
 * agent commit but before the `preset_agent` marker would leave an org whose
 * reserved slug is taken by an agent no marker describes: the next boot's
 * backfill sees the collision and writes a PERMANENT `skipped`, and nothing ever
 * repairs it (creation has no later trigger).
 */
describe('org-creation atomicity (§3.2)', () => {
  // Fault injection at the LAST write of the seam. Wrapping `$transaction` is what
  // makes this a real test: the callback must receive the POISONED client, or the
  // seam would happily commit through the untouched one.
  function prismaFailingPresetMarker(): PrismaClient {
    const poison = (tx: PrismaClient): PrismaClient =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== 'presetAgent') return Reflect.get(target, prop, receiver) as unknown
          return {
            ...(Reflect.get(target, prop, receiver) as object),
            create: () => Promise.reject(new Error('injected: preset marker write failed'))
          }
        }
      }) as PrismaClient
    return new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver) as unknown
        return (fn: (tx: PrismaClient) => Promise<unknown>) =>
          (target as PrismaClient).$transaction((tx) => fn(poison(tx as unknown as PrismaClient)))
      }
    }) as PrismaClient
  }

  it('a failed preset write rolls the whole personal org back (JIT signup, no ambient tx)', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `rollback-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Rollback' }
    })

    await expect(ensurePersonalOrg(prismaFailingPresetMarker(), user.id, 'Rollback', user.email)).rejects.toThrow(
      /injected/
    )

    // Nothing partially committed: no org, no membership, and above all no agent
    // squatting the reserved slug with no marker to describe it.
    expect(await prisma.membership.findFirst({ where: { userId: user.id } })).toBeNull()
    expect(await prisma.agent.findFirst({ where: { name: GENERAL_PRESET.name, createdByUserId: user.id } })).toBeNull()

    // And the path is genuinely re-runnable afterwards — the failure left no trace
    // that would make the retry collide.
    await ensurePersonalOrg(prisma, user.id, 'Rollback', user.email)
    const membership = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } })
    const row = await prisma.presetAgent.findUnique({
      where: { orgId_preset: { orgId: membership.orgId, preset: 'general' } }
    })
    expect(row?.status).toBe('created')
    const agent = await prisma.agent.findUnique({
      where: { orgId_name: { orgId: membership.orgId, name: GENERAL_PRESET.name } }
    })
    expect(agent?.id).toBe(row?.agentId)
  })

  it('composes under an ambient transaction instead of nesting (waitlist redeem)', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `ambient-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Ambient' }
    })

    // The redeem's own transaction wraps the seam; a rollback out here must undo
    // the preset too (the whole point of composing rather than opening a nested one).
    await expect(
      prisma.$transaction(async (tx) => {
        await ensurePersonalOrg(tx, user.id, 'Ambient', user.email)
        // The seam's writes ARE visible inside the caller's transaction.
        const m = await tx.membership.findFirstOrThrow({ where: { userId: user.id } })
        expect(
          await tx.presetAgent.findUnique({ where: { orgId_preset: { orgId: m.orgId, preset: 'general' } } })
        ).not.toBeNull()
        throw new Error('redeem failed after provisioning')
      })
    ).rejects.toThrow(/redeem failed/)

    expect(await prisma.membership.findFirst({ where: { userId: user.id } })).toBeNull()
    expect(await prisma.agent.findFirst({ where: { createdByUserId: user.id } })).toBeNull()
  })

  it('the no-auth default tenant provisions the preset in its own transaction', async () => {
    // Truncated DB: re-seeding is the same call production makes at boot.
    await prisma.presetAgent.deleteMany({ where: { orgId: DEFAULT_ORG_ID } })
    await prisma.agent.deleteMany({ where: { orgId: DEFAULT_ORG_ID, name: GENERAL_PRESET.name } })

    await ensureDefaultTenant(prisma)

    const row = await prisma.presetAgent.findUnique({
      where: { orgId_preset: { orgId: DEFAULT_ORG_ID, preset: 'general' } }
    })
    expect(row?.status).toBe('created')

    // Idempotent across boots — no duplicate agent, no second marker attempt.
    await ensureDefaultTenant(prisma)
    expect(await prisma.agent.count({ where: { orgId: DEFAULT_ORG_ID, name: GENERAL_PRESET.name } })).toBe(1)
  })
})

describe('deferred-runtime tolerance of existing routes', () => {
  it('PUT /agents/:id/daemon on a runtime-less agent is a clean 409', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
      const preset = await prisma.agent.findUnique({
        where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } }
      })
      const daemonId = randomUUID()
      await seedDaemon(prisma, daemonId)

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${preset!.id}/daemon`,
        payload: { daemonId }
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as { message: string }).message).toMatch(/set a runtime/)
    } finally {
      await close()
    }
  })

  it('PATCH can set the deferred runtime; placement then settles the preset', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      await provisionPresetAgents(prisma, { orgId: DEFAULT_ORG_ID })
      const preset = await prisma.agent.findUnique({
        where: { orgId_name: { orgId: DEFAULT_ORG_ID, name: 'agentconnect' } }
      })

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${preset!.id}`,
        payload: { runtime: 'claude' }
      })
      expect(patched.statusCode).toBe(200)
      expect((patched.json() as AgentBody).runtime).toBe('claude')

      // First placement of any kind stamps placementSettledAt (repo anchor).
      const daemonId = randomUUID()
      await seedDaemon(prisma, daemonId)
      await new PgAgentRepo(prisma).setPlacement(AgentId(preset!.id), DaemonId(daemonId))
      const row = await prisma.presetAgent.findUnique({
        where: { orgId_preset: { orgId: DEFAULT_ORG_ID, preset: 'general' } }
      })
      expect(row?.placementSettledAt).toBeInstanceOf(Date)
    } finally {
      await close()
    }
  })

  it('an ordinary placed agent still lists with its runtime (no regression)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const daemonId = randomUUID()
      await seedDaemon(prisma, daemonId)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { daemonId })

      const list = await app.inject({ method: 'GET', url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents` })
      const agents = list.json() as AgentBody[]
      expect(agents.find((a) => a.id === agentId)?.runtime).toBe('claude')
    } finally {
      await close()
    }
  })
})
