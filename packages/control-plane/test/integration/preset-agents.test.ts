/**
 * Preset agents, M0 (docs/designs/preset-agents.md §3) — the org-creation seam,
 * the one-time backfill, the reserved slugs, and the deferred-runtime tolerance
 * of the existing routes.
 */
import { onDaemon } from '../../src/domain/placement.js'
import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import type { IconStore } from '../../src/icons/icon-store.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { poolSetId, seedPoolMember } from '../fakes/member-set.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import {
  GENERAL_PRESET,
  PRESET_AGENT_SKILLS,
  PRESET_SKILL_SOURCE,
  PresetAgentBackfill,
  provisionPresetAgents
} from '../../src/persistence/index.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { ensureDefaultTenant } from '../../src/persistence/ensure-default-tenant.js'
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'

const silentLog = { info() {}, warn() {} }

interface AgentBody {
  id: string
  name: string
  displayName: string | null
  builtin: boolean
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
      expect(preset.builtin).toBe(true) // derived from its preset_agent row
      expect(preset.runtime).toBeNull() // deferred exec config
      expect(preset.daemonId).toBeNull() // unplaced
      expect(preset.icon).toEqual(GENERAL_PRESET.icon) // fixed brand glyph, not random

      const row = await prisma.presetAgent.findUnique({
        where: { orgId_preset: { orgId, preset: 'general' } }
      })
      expect(row).toMatchObject({ agentId: preset.id, status: 'created', placementSettledAt: null })

      // Default skill (§3.1): the org-level source row plus the preset's enable-list,
      // written in the same transaction as the org itself.
      const source = await prisma.skillSource.findUnique({
        where: { orgId_name: { orgId, name: PRESET_SKILL_SOURCE.name } }
      })
      expect(source).toMatchObject({
        source: PRESET_SKILL_SOURCE.source,
        githubRepoId: PRESET_SKILL_SOURCE.githubRepoId,
        ref: PRESET_SKILL_SOURCE.ref,
        subDir: PRESET_SKILL_SOURCE.subDir,
        skills: [...PRESET_SKILL_SOURCE.skills],
        visibility: 'org',
        createdByUserId: null // system write, like the agent row
      })
      const agentRow = await prisma.agent.findUniqueOrThrow({ where: { id: preset.id } })
      expect((agentRow.runtimeOverrides as { skills?: string[] }).skills).toEqual([...PRESET_AGENT_SKILLS])
    } finally {
      await close()
    }
  })

  it('an org already owning the skill-source name gets the preset without default skills', async () => {
    const org = await prisma.org.create({ data: { slug: `src-collide-${randomUUID().slice(0, 8)}` } })
    await prisma.skillSource.create({
      data: { orgId: org.id, name: PRESET_SKILL_SOURCE.name, source: 'someone/else' }
    })

    await provisionPresetAgents(prisma, { orgId: org.id })

    // The user's source is untouched — never captured, never rewritten.
    const source = await prisma.skillSource.findUnique({
      where: { orgId_name: { orgId: org.id, name: PRESET_SKILL_SOURCE.name } }
    })
    expect(source?.source).toBe('someone/else')

    // The preset still provisions — binding it to a source we did not write would
    // install someone else's content, so the enable-list simply stays empty.
    const agent = await prisma.agent.findUniqueOrThrow({
      where: { orgId_name: { orgId: org.id, name: GENERAL_PRESET.name } }
    })
    expect(((agent.runtimeOverrides ?? {}) as { skills?: string[] }).skills ?? []).toEqual([])
  })

  it('an install running a pool is born placed on it, with the deployment’s runtime and model', async () => {
    await seedPoolMember(prisma, randomUUID())
    const org = await prisma.org.create({ data: { slug: `pool-born-${randomUUID().slice(0, 8)}` } })

    await provisionPresetAgents(prisma, { orgId: org.id, pool: { runtime: 'dsh-acp', model: 'deepseek-v4-flash' } })

    const agent = await prisma.agent.findUniqueOrThrow({
      where: { orgId_name: { orgId: org.id, name: GENERAL_PRESET.name } }
    })
    expect(agent.placementKind).toBe('set')
    expect(agent.setId).toBe(await poolSetId(prisma))
    expect(agent.daemonId).toBeNull() // a set names no machine
    expect(agent.status).toBe('active') // a placed agent is active from row one
    expect(agent.runtime).toBe('dsh-acp')
    expect((agent.runtimeOverrides as { model?: string }).model).toBe('deepseek-v4-flash')

    // Born placed ⇒ born settled: nothing may auto-place it again, or fight a later unplace.
    const row = await prisma.presetAgent.findUniqueOrThrow({
      where: { orgId_preset: { orgId: org.id, preset: 'general' } }
    })
    expect(row.placementSettledAt).not.toBeNull()
  })

  it('an install with no pool member is born unplaced even with a pool runtime configured', async () => {
    // The org-less set ROW exists on every install (the migration mints it) — only
    // membership says whether this deployment actually runs a pool.
    const org = await prisma.org.create({ data: { slug: `no-pool-${randomUUID().slice(0, 8)}` } })

    await provisionPresetAgents(prisma, { orgId: org.id, pool: { runtime: 'dsh-acp', model: 'deepseek-v4-flash' } })

    const agent = await prisma.agent.findUniqueOrThrow({
      where: { orgId_name: { orgId: org.id, name: GENERAL_PRESET.name } }
    })
    expect(agent.placementKind).toBe('daemon')
    expect(agent.setId).toBeNull()
    expect(agent.daemonId).toBeNull()
    expect(agent.runtime).toBeNull() // deferred exec config, as before
    const row = await prisma.presetAgent.findUniqueOrThrow({
      where: { orgId_preset: { orgId: org.id, preset: 'general' } }
    })
    expect(row.placementSettledAt).toBeNull()
  })

  it('DELETE refuses the built-in preset (403) but still deletes ordinary agents', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { slug: 'del-org' } })
      const orgId = (created.json() as { id: string }).id
      const agents = (await (await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/agents` })).json()) as {
        id: string
      }[]

      // The preset is a permanent org fixture (preset-agents.md §2, 2026-07-29).
      const del = await app.inject({ method: 'DELETE', url: `/api/v1/orgs/${orgId}/agents/${agents[0]!.id}` })
      expect(del.statusCode).toBe(403)
      expect((del.json() as { message: string }).message).toMatch(/built-in/)

      // Untouched: the agent row and its preset marker both survive, unsettled.
      expect(await prisma.agent.findUnique({ where: { id: agents[0]!.id } })).not.toBeNull()
      const row = await prisma.presetAgent.findUnique({
        where: { orgId_preset: { orgId, preset: 'general' } }
      })
      expect(row).toMatchObject({ agentId: agents[0]!.id, placementSettledAt: null })

      // The guard is preset-scoped: an ordinary sibling still deletes cleanly.
      const sibling = await app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${orgId}/agents`,
        payload: { name: 'ordinary', runtime: 'claude' }
      })
      expect(sibling.statusCode).toBe(201)
      const siblingBody = sibling.json() as AgentBody
      expect(siblingBody.builtin).toBe(false)
      const delSibling = await app.inject({
        method: 'DELETE',
        url: `/api/v1/orgs/${orgId}/agents/${siblingBody.id}`
      })
      expect(delSibling.statusCode).toBe(204)
    } finally {
      await close()
    }
  })

  it('the built-in identity is immutable — display name, icon, and icon uploads all 403', async () => {
    const PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
      0, 0, 0, 0
    ])
    const store: IconStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
      publicUrl: vi.fn(() => 'https://images.example.test/x')
    }
    const { app, close } = buildHttpApp(prisma, {}, undefined, undefined, { iconStore: store })
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/orgs', payload: { slug: 'identity-org' } })
      const orgId = (created.json() as { id: string }).id
      const agents = (await (await app.inject({ method: 'GET', url: `/api/v1/orgs/${orgId}/agents` })).json()) as {
        id: string
      }[]
      const base = `/api/v1/orgs/${orgId}/agents/${agents[0]!.id}`

      for (const payload of [{ displayName: 'Renamed' }, { icon: { kind: 'glyph', glyph: 'bot', color: '#c62a78' } }]) {
        const res = await app.inject({ method: 'PATCH', url: base, payload })
        expect(res.statusCode).toBe(403)
        expect((res.json() as { message: string }).message).toMatch(/identity/)
      }
      // Everything else stays an ordinary edit — the preset is a normal agent.
      expect(
        (await app.inject({ method: 'PATCH', url: base, payload: { description: 'still mine' } })).statusCode
      ).toBe(200)

      // The dedicated upload/reset routes refuse the same way.
      const up = await app.inject({
        method: 'PUT',
        url: `${base}/icon`,
        headers: { 'content-type': 'image/png' },
        payload: PNG
      })
      expect(up.statusCode).toBe(403)
      expect((await app.inject({ method: 'DELETE', url: `${base}/icon` })).statusCode).toBe(403)
      expect(store.put).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

describe('reserved agent slugs (§3.3)', () => {
  it('POST /agents refuses the reserved slug agentconnect', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
        payload: { name: 'agentconnect', runtime: 'claude' }
      })
      // The zod refine surfaces as the validator's generic 400 (same as the
      // reserved ORG slugs); the sibling below proves the slug is the reason.
      expect(res.statusCode).toBe(400)
      const sibling = await app.inject({
        method: 'POST',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
        payload: { name: 'agentconnect-2', runtime: 'claude' }
      })
      expect(sibling.statusCode).toBe(201)
    } finally {
      await close()
    }
  })

  it.each(['agentconnect-assistant', 'agent-assistant', 'assistant'])(
    'released assistant slug %s is user-creatable (reservation lifted 2026-07-29)',
    async (name) => {
      const { app, close } = buildHttpApp(prisma)
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
          payload: { name, runtime: 'claude' }
        })
        expect(res.statusCode).toBe(201)
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
    await new PgAgentRepo(prisma).delete(OrgId(clean.id), AgentId(provisioned!.id))
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
 * `POST /orgs` reaches the seam with the ROOT client, not a transaction — so
 * `PgOrgRepo.create` must open one itself. Without that, a crash after the agent
 * commit but before the `preset_agent` marker would leave an org whose reserved
 * slug is taken by an agent no marker describes: the next boot's backfill sees the
 * collision and writes a PERMANENT `skipped`, and nothing ever repairs it
 * (creation has no later trigger).
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

  it('a failed preset write rolls the whole org back (POST /orgs, no ambient tx)', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `rollback-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Rollback' }
    })
    const slug = `rollback-${randomUUID().slice(0, 8)}`

    await expect(
      new PgOrgRepo(prismaFailingPresetMarker()).create({ name: null, slug, ownerUserId: user.id })
    ).rejects.toThrow(/injected/)

    // Nothing partially committed: no org, no membership, and above all no agent
    // squatting the reserved slug with no marker to describe it.
    expect(await prisma.membership.findFirst({ where: { userId: user.id } })).toBeNull()
    expect(await prisma.agent.findFirst({ where: { name: GENERAL_PRESET.name, createdByUserId: user.id } })).toBeNull()

    // And the path is genuinely re-runnable afterwards — the failure left no trace
    // that would make the retry collide.
    await new PgOrgRepo(prisma).create({ name: null, slug, ownerUserId: user.id })
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

  it('composes under an ambient transaction instead of nesting', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), email: `ambient-${randomUUID().slice(0, 8)}@example.com`, displayName: 'Ambient' }
    })

    // A caller's own transaction wraps the seam; a rollback out here must undo the
    // preset too (the whole point of composing rather than opening a nested one).
    await expect(
      prisma.$transaction(async (tx) => {
        await new PgOrgRepo(tx).create({
          name: null,
          slug: `ambient-${randomUUID().slice(0, 8)}`,
          ownerUserId: user.id
        })
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
      await new PgAgentRepo(prisma).setPlacement(AgentId(preset!.id), onDaemon(DaemonId(daemonId)))
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
