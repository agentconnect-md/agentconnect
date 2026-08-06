/**
 * Tenant-isolation contract suite (docs/designs/org-scoped-data-layer.md §6).
 *
 * Two organizations share one Postgres; the caller (devAuth = seeded owner of
 * the DEFAULT org) addresses the FOREIGN org's resources by raw id through the
 * caller's own `/orgs/:orgId` subtree. The org fence now lives in the
 * repository layer, so every point read, mutation, and list must behave as if
 * the foreign row does not exist — 404 on the wire, `null`/missing-row errors
 * at the repo — and the foreign row must be provably unmodified afterwards.
 *
 * This file is the acceptance gate for the org-scoped data-layer rollout:
 * migrating a repository (§7 M2) adds its resource block here in the same PR.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { AgentMissing } from '../../src/persistence/errors.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const CALLER_ORG = OrgId(DEFAULT_ORG_ID)

let running: HttpApp | undefined
let foreignOrgId: string
let foreignAgentId: string
let ownAgentId: string

afterEach(async () => {
  await running?.close()
  running = undefined
})

beforeEach(async () => {
  // The caller's own agent (DEFAULT org) and a foreign org holding one agent.
  ownAgentId = randomUUID()
  await seedAgent(prisma, ownAgentId, { name: 'own-bot' })
  foreignOrgId = `org-foreign-${randomUUID().slice(0, 8)}`
  foreignAgentId = randomUUID()
  await prisma.org.create({ data: { id: foreignOrgId, slug: foreignOrgId } })
  await prisma.agent.create({
    data: { id: foreignAgentId, orgId: foreignOrgId, name: 'foreign-bot', runtime: 'claude' }
  })
})

function build(): HttpApp {
  const app = buildHttpApp(prisma)
  running = app
  return app
}

async function foreignRowUnmodified(): Promise<void> {
  const row = await prisma.agent.findUnique({ where: { id: foreignAgentId } })
  expect(row).not.toBeNull()
  expect(row!.orgId).toBe(foreignOrgId)
  expect(row!.name).toBe('foreign-bot')
}

describe('tenant isolation — Agent over the REST surface', () => {
  it('point-GET of a foreign agent id reads as absent (404), never as someone else’s resource', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${foreignAgentId}` })
    expect(res.statusCode).toBe(404)
  })

  it('PATCH of a foreign agent id is 404 and provably writes nothing', async () => {
    const app = build()
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${foreignAgentId}`,
      payload: { description: 'hijacked' }
    })
    expect(res.statusCode).toBe(404)
    await foreignRowUnmodified()
  })

  it('DELETE of a foreign agent id is 404 and the row survives', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${foreignAgentId}` })
    expect(res.statusCode).toBe(404)
    await foreignRowUnmodified()
  })

  it('sharing and call-policy writes on a foreign agent id are 404 and write nothing', async () => {
    const app = build()
    const sharing = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${foreignAgentId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    expect(sharing.statusCode).toBe(404)
    const policy = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${foreignAgentId}/call-policy`,
      payload: { callPolicy: 'all', allowedCallerAgentIds: [] }
    })
    expect(policy.statusCode).toBe(404)
    await foreignRowUnmodified()
  })

  it('a PATCH losing the delete race still reads as 404 (AgentMissing → not-found mapping)', async () => {
    const app = build()
    // Delete the row right after the route's SECOND read — the post-lease
    // optimistic-CAS refresh — returns it. An earlier delete is absorbed by the
    // route's own "agent changed" 409 guard; this interleaving is the one only
    // the repo-level update fence can refuse, and it must surface as 404.
    const repo = app.deps.repos.agent
    const realGet = repo.get.bind(repo)
    let reads = 0
    repo.get = async (orgId, id) => {
      const row = await realGet(orgId, id)
      if (row?.id === ownAgentId && ++reads === 2) await prisma.agent.delete({ where: { id: ownAgentId } })
      return row
    }
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${ownAgentId}`,
      payload: { description: 'race' }
    })
    expect(res.statusCode).toBe(404)
  })

  it('the agents list never contains a foreign row', async () => {
    const app = build()
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/agents` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((a) => a.id)
    expect(ids).toContain(ownAgentId)
    expect(ids).not.toContain(foreignAgentId)
  })
})

describe('tenant isolation — AgentRepo fences under the routes', () => {
  it('org-fenced reads and mutations treat a cross-org id exactly like a missing row', async () => {
    const repo = new PgAgentRepo(prisma)

    // Point read: cross-org id and unknown id are indistinguishable.
    expect(await repo.get(CALLER_ORG, AgentId(foreignAgentId))).toBeNull()
    expect(await repo.get(CALLER_ORG, AgentId(randomUUID()))).toBeNull()
    expect(await repo.get(CALLER_ORG, AgentId(ownAgentId))).not.toBeNull()

    // update: the fence throws the typed missing-row error before any write.
    await expect(repo.update(CALLER_ORG, AgentId(foreignAgentId), { description: 'hijacked' })).rejects.toBeInstanceOf(
      AgentMissing
    )

    // delete: the fenced Prisma delete keeps its missing-row error semantics.
    await expect(repo.delete(CALLER_ORG, AgentId(foreignAgentId))).rejects.toThrow()

    // CAS-shaped workspace edit: a cross-org id misses like a stale expectation.
    expect(
      await repo.setWorkspace(CALLER_ORG, AgentId(foreignAgentId), new Date(), 'scratch', { mode: 'scratch' })
    ).toBeNull()

    await foreignRowUnmodified()

    // The unscoped read is the internal-trust-domain escape hatch — it does
    // resolve the row, which is exactly why lint keeps it off the HTTP surface.
    expect(await repo.getUnscoped(AgentId(foreignAgentId))).not.toBeNull()
  })
})
