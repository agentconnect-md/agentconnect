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
