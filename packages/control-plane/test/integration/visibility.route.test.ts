/**
 * Per-resource visibility enforcement (docs/designs/resource-visibility.md).
 *
 * Under devAuth the principal is fixed to `DEFAULT_OWNER_ID`, so we act "as" a
 * given user by building a second app with `{ DEFAULT_OWNER_ID: userId }`. Users
 * are provisioned + added to the default org with a role; agents are seeded with
 * a visibility + share set. Every request runs through the real HTTP stack.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

const users = () => new PgUserRepo(prisma)
const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

/** Provision a user + add them to the default org with a role; returns their id. */
async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@acme.dev`
  const { userId } = await users().provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users().addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** An app whose devAuth principal is `userId` — i.e. "act as this user". */
function appAs(userId: string): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(app)
  return app
}

const agentIds = (body: unknown): string[] => (body as Array<{ id: string }>).map((a) => a.id)

describe('agent visibility — list & get', () => {
  it('a restricted agent is visible only to its ownership arm and grantees, regardless of role', async () => {
    const creator = await makeUser('vis-creator', 'collaborator')
    const grantee = await makeUser('vis-grantee', 'collaborator')
    const other = await makeUser('vis-other', 'collaborator')
    const owner = await makeUser('vis-owner', 'owner')

    const R = randomUUID()
    await seedAgent(prisma, R, { visibility: 'restricted', sharedWith: [grantee], createdByUserId: creator })

    // Non-granted collaborator: absent from list, 404 on get.
    const otherApp = appAs(other)
    expect(agentIds((await otherApp.app.inject({ method: 'GET', url: `${ORG}/agents` })).json())).not.toContain(R)
    expect((await otherApp.app.inject({ method: 'GET', url: `${ORG}/agents/${R}` })).statusCode).toBe(404)

    // Creator and grantee see it.
    for (const u of [creator, grantee]) {
      const res = await appAs(u).app.inject({ method: 'GET', url: `${ORG}/agents/${R}` })
      expect(res.statusCode).toBe(200)
      expect(agentIds((await appAs(u).app.inject({ method: 'GET', url: `${ORG}/agents` })).json())).toContain(R)
    }
    // Organization ownership is not a visibility bypass.
    expect((await appAs(owner).app.inject({ method: 'GET', url: `${ORG}/agents/${R}` })).statusCode).toBe(404)
    expect(agentIds((await appAs(owner).app.inject({ method: 'GET', url: `${ORG}/agents` })).json())).not.toContain(R)
  })

  it('the list SQL filter and the canView predicate agree (no leak, no false hide)', async () => {
    const grantee = await makeUser('agree-grantee', 'collaborator')
    const other = await makeUser('agree-other', 'collaborator')
    await seedAgent(prisma, randomUUID(), { visibility: 'org' }) // everyone
    await seedAgent(prisma, randomUUID(), { visibility: 'restricted', sharedWith: [grantee] }) // grantee only
    await seedAgent(prisma, randomUUID(), { visibility: 'restricted', sharedWith: [] }) // creator only

    const granteeList = agentIds((await appAs(grantee).app.inject({ method: 'GET', url: `${ORG}/agents` })).json())
    const otherList = agentIds((await appAs(other).app.inject({ method: 'GET', url: `${ORG}/agents` })).json())
    expect(granteeList.length).toBe(2) // org + shared
    expect(otherList.length).toBe(1) // org only
  })
})

describe('agent visibility — write gates', () => {
  it('a granted viewer can GET but not PATCH; a granted collaborator can PATCH; a non-granted collaborator 404s', async () => {
    const grantee = await makeUser('w-grantee', 'collaborator')
    const viewer = await makeUser('w-viewer', 'viewer')
    const other = await makeUser('w-other', 'collaborator')
    const R = randomUUID()
    await seedAgent(prisma, R, { visibility: 'restricted', sharedWith: [grantee, viewer] })

    const patch = (u: string) =>
      appAs(u).app.inject({ method: 'PATCH', url: `${ORG}/agents/${R}`, payload: { description: 'x' } })

    expect((await appAs(viewer).app.inject({ method: 'GET', url: `${ORG}/agents/${R}` })).statusCode).toBe(200)
    expect((await patch(viewer)).statusCode).toBe(403) // visible but read-only
    expect((await patch(grantee)).statusCode).toBe(200) // shared collaborator can edit
    expect((await patch(other)).statusCode).toBe(404) // can't even see it
  })

  it('the tightened workspace routes 404 for a user who can’t see the agent', async () => {
    const other = await makeUser('ws-other', 'collaborator')
    const daemon = randomUUID()
    await seedDaemon(prisma, daemon)
    const R = randomUUID()
    await seedAgent(prisma, R, { daemonId: daemon, visibility: 'restricted', sharedWith: [] })
    // getOrgAgent (org + canView) 404s BEFORE any daemon call — no live daemon needed.
    const res = await appAs(other).app.inject({ method: 'GET', url: `${ORG}/agents/${R}/workspace/gitstatus` })
    expect(res.statusCode).toBe(404)
  })
})

describe('agent sharing endpoint (canManageSharing === canEdit, §13.3)', () => {
  it('a shared collaborator can re-share, a shared viewer cannot, and unshared members 404 regardless of role', async () => {
    const grantee = await makeUser('sh-grantee', 'collaborator')
    const viewer = await makeUser('sh-viewer', 'viewer')
    const other = await makeUser('sh-other', 'collaborator')
    const owner = await makeUser('sh-owner', 'owner')
    const R = randomUUID()
    await seedAgent(prisma, R, { visibility: 'restricted', sharedWith: [grantee, viewer] })

    const share = (u: string, sharedWith: string[]) =>
      appAs(u).app.inject({
        method: 'PUT',
        url: `${ORG}/agents/${R}/sharing`,
        payload: { visibility: 'restricted', sharedWith }
      })

    expect((await share(grantee, [grantee, other])).statusCode).toBe(200) // relaxed: edit ⇒ manage sharing
    // The grantee's re-share added `other`, who can now see it (widening took effect).
    expect((await appAs(other).app.inject({ method: 'GET', url: `${ORG}/agents/${R}` })).statusCode).toBe(200)
    expect((await share(viewer, [grantee])).statusCode).toBe(403) // viewer read-only, set unchanged
    expect((await share(owner, [grantee, other])).statusCode).toBe(404) // role does not widen visibility
  })

  it('sharedWith is intersected with current org members (foreign ids dropped)', async () => {
    const owner = await makeUser('int-owner', 'owner')
    const member = await makeUser('int-member', 'collaborator')
    const R = randomUUID()
    await seedAgent(prisma, R, { visibility: 'org' })
    const res = await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${R}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [member, 'ghost-not-a-member'] }
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { sharedWith: string[] }).sharedWith).toEqual([member])
  })
})

describe('mcp provider visibility — list, get, sharing, enable-gate', () => {
  const MCP = `${ORG}/mcp-providers`
  const ids = (body: unknown): string[] => (body as Array<{ id: string }>).map((p) => p.id)

  /** Seed an mcp_provider row directly (bypasses the relay push in POST). */
  async function seedProvider(
    id: string,
    opts: {
      name: string
      visibility?: 'org' | 'restricted'
      sharedWith?: string[]
      createdByUserId?: string
      ownerUserId?: string
    }
  ): Promise<void> {
    const ownerUserId = opts.ownerUserId ?? opts.createdByUserId
    await prisma.mcpProvider.create({
      data: {
        id,
        orgId: DEFAULT_ORG_ID,
        name: opts.name,
        url: 'https://mcp.example.com/sse',
        ...(opts.visibility ? { visibility: opts.visibility } : {}),
        ...(opts.sharedWith ? { sharedWith: opts.sharedWith } : {}),
        ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
        ...(ownerUserId ? { ownerUserId } : {})
      }
    })
  }

  it('a restricted provider is visible only to its ownership arm and grantees, regardless of role', async () => {
    const creator = await makeUser('mcp-creator', 'collaborator')
    const grantee = await makeUser('mcp-grantee', 'collaborator')
    const other = await makeUser('mcp-other', 'collaborator')
    const owner = await makeUser('mcp-owner', 'owner')
    const P = randomUUID()
    await seedProvider(P, {
      name: 'mcp-vis-linear',
      visibility: 'restricted',
      sharedWith: [grantee],
      createdByUserId: creator
    })

    expect(ids((await appAs(other).app.inject({ method: 'GET', url: MCP })).json())).not.toContain(P)
    expect((await appAs(other).app.inject({ method: 'GET', url: `${MCP}/${P}` })).statusCode).toBe(404)
    for (const u of [creator, grantee]) {
      expect((await appAs(u).app.inject({ method: 'GET', url: `${MCP}/${P}` })).statusCode).toBe(200)
    }
    expect((await appAs(owner).app.inject({ method: 'GET', url: `${MCP}/${P}` })).statusCode).toBe(404)
  })

  it('PUT /mcp-providers/:id/sharing lets an owner widen only when they own the resource', async () => {
    const owner = await makeUser('mcp-sh-owner', 'owner')
    const member = await makeUser('mcp-sh-member', 'collaborator')
    const other = await makeUser('mcp-sh-other', 'collaborator')
    const P = randomUUID()
    await seedProvider(P, {
      name: 'mcp-sh',
      visibility: 'restricted',
      sharedWith: [],
      createdByUserId: owner
    })

    const share = (u: string, sharedWith: string[]) =>
      appAs(u).app.inject({
        method: 'PUT',
        url: `${MCP}/${P}/sharing`,
        payload: { visibility: 'restricted', sharedWith }
      })

    expect((await share(other, [member])).statusCode).toBe(404) // can't even see it
    const ok = await share(owner, [member, 'ghost-not-a-member']) // ghost dropped by member intersect
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { sharedWith: string[] }).sharedWith).toEqual([member])
    expect((await appAs(member).app.inject({ method: 'GET', url: `${MCP}/${P}` })).statusCode).toBe(200)
  })

  it('the enable-list gate lets a user disable an unseen provider but only its owner can add it back', async () => {
    const owner = await makeUser('mcp-en-owner', 'owner')
    const other = await makeUser('mcp-en-other', 'collaborator')
    const daemon = randomUUID()
    await seedDaemon(prisma, daemon)
    await seedProvider(randomUUID(), {
      name: 'mcp-hidden',
      visibility: 'restricted',
      sharedWith: [],
      createdByUserId: owner
    })
    const A = randomUUID()
    await seedAgent(prisma, A, { daemonId: daemon, visibility: 'org' })
    // Pre-enable the hidden provider on the agent (the enable-list lives in runtimeOverrides).
    await prisma.agent.update({ where: { id: A }, data: { runtimeOverrides: { mcpServers: ['mcp-hidden'] } } })

    const patchMcp = (u: string, mcpServers: string[]) =>
      appAs(u).app.inject({ method: 'PATCH', url: `${ORG}/agents/${A}`, payload: { mcpServers } })

    expect((await patchMcp(other, [])).statusCode).toBe(200) // disable: removal-only, allowed
    expect((await patchMcp(other, ['mcp-hidden'])).statusCode).toBe(403) // add back an unseen provider: denied
    expect((await patchMcp(owner, ['mcp-hidden'])).statusCode).toBe(200) // resource ownership grants access
  })
})

describe('skill source visibility — the agent that enables it resolves it anyway', () => {
  /** Seed a skill_source row directly (no GitHub scan, no fan-out). `source`
   *  bypasses `SkillSourceArg`, which is how a pre-guard row is simulated. */
  async function seedSource(
    id: string,
    opts: {
      name: string
      source?: string
      visibility?: 'org' | 'restricted'
      sharedWith?: string[]
      createdByUserId?: string
      ownerUserId?: string
    }
  ): Promise<void> {
    const ownerUserId = opts.ownerUserId ?? opts.createdByUserId
    await prisma.skillSource.create({
      data: {
        id,
        orgId: DEFAULT_ORG_ID,
        name: opts.name,
        source: opts.source ?? 'example-org/example-ai-kit',
        ...(opts.visibility ? { visibility: opts.visibility } : {}),
        ...(opts.sharedWith ? { sharedWith: opts.sharedWith } : {}),
        ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
        ...(ownerUserId ? { ownerUserId } : {})
      }
    })
  }

  it('a source hidden from the registry list still resolves through an agent the caller can see', async () => {
    const other = await makeUser('sk-other', 'collaborator')
    const S = randomUUID()
    await seedSource(S, { name: 'sk-hidden-kit', visibility: 'restricted', sharedWith: [] })
    const A = randomUUID()
    await seedAgent(prisma, A, { visibility: 'org' })
    await prisma.agent.update({ where: { id: A }, data: { runtimeOverrides: { skills: ['sk-hidden-kit/*'] } } })

    const app = appAs(other).app
    // Hidden from the org registry — sharing still applies there.
    const list = (await app.inject({ method: 'GET', url: `${ORG}/skill-sources` })).json() as Array<{ id: string }>
    expect(list.map((s) => s.id)).not.toContain(S)
    expect((await app.inject({ method: 'GET', url: `${ORG}/skill-sources/${S}` })).statusCode).toBe(404)

    // But the agent's own enable-list resolves it, so the console can name the repo
    // instead of rendering a bare, unexplained row.
    const res = await app.inject({ method: 'GET', url: `${ORG}/agents/${A}/skill-sources` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { id: S, name: 'sk-hidden-kit', source: 'example-org/example-ai-kit', ref: null, subDir: null, skills: [] }
    ])
    // Reading it there does NOT loosen the write gate: the ref can be dropped but
    // not re-added, so the console renders that tile off-only.
    const patch = (skills: string[]) => app.inject({ method: 'PATCH', url: `${ORG}/agents/${A}`, payload: { skills } })
    expect((await patch([])).statusCode).toBe(200)
    expect((await patch(['sk-hidden-kit/*'])).statusCode).toBe(403)
  })

  it('an enable-list ref to a source that no longer exists resolves to nothing', async () => {
    const other = await makeUser('sk-gone', 'collaborator')
    const A = randomUUID()
    await seedAgent(prisma, A, { visibility: 'org' })
    await prisma.agent.update({ where: { id: A }, data: { runtimeOverrides: { skills: ['sk-deleted/*'] } } })

    const res = await appAs(other).app.inject({ method: 'GET', url: `${ORG}/agents/${A}/skill-sources` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('a secret in a pre-guard source never crosses the boundary, in any of its hiding places', async () => {
    const other = await makeUser('sk-cred', 'collaborator')
    // Rows from before SkillSourceArg rejected secrets, each restricted away from
    // `other` but reachable through an agent they can see. The last two are the
    // bypasses a hand-rolled userinfo regex misses: a password containing `@`
    // (minimal matching stops at the first one) and a token in the query/fragment.
    const cases = [
      { name: 'sk-cred-user', stored: 'https://ghp_notarealtoken@git.example.test/ops/skills.git' },
      { name: 'sk-cred-pw', stored: 'https://user:p@ss-notarealtoken@git.example.test/ops/skills.git' },
      { name: 'sk-cred-query', stored: 'https://git.example.test/ops/skills.git?access_token=notarealtoken#frag' }
    ]
    for (const c of cases) {
      await seedSource(randomUUID(), { name: c.name, source: c.stored, visibility: 'restricted', sharedWith: [] })
    }
    const A = randomUUID()
    await seedAgent(prisma, A, { visibility: 'org' })
    await prisma.agent.update({
      where: { id: A },
      data: { runtimeOverrides: { skills: cases.map((c) => `${c.name}/*`) } }
    })

    const res = await appAs(other).app.inject({ method: 'GET', url: `${ORG}/agents/${A}/skill-sources` })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ name: string; source: string }>
    expect(rows.map((r) => r.source)).toEqual([
      'https://git.example.test/ops/skills.git',
      'https://git.example.test/ops/skills.git',
      'https://git.example.test/ops/skills.git'
    ])
    expect(res.payload).not.toContain('notarealtoken')
  })

  it('the write path refuses every secret-bearing source form, even from an owner', async () => {
    const owner = await makeUser('sk-cred-owner', 'owner')
    const create = (source: string) =>
      appAs(owner).app.inject({ method: 'POST', url: `${ORG}/skill-sources`, payload: { name: 'sk-cred-new', source } })

    for (const bad of [
      'https://user:pw@git.example.test/ops/skills.git',
      'https://ghp_notarealtoken@github.com/example-org/kit',
      'https://user:p@ss@git.example.test/ops/skills.git', // password containing `@`
      'https://git.example.test/ops/skills.git?access_token=notarealtoken', // query
      'https://git.example.test/ops/skills.git#notarealtoken' // fragment
    ]) {
      expect((await create(bad)).statusCode).toBe(400)
    }
    expect((await create('git@github.com:example-org/example-kit.git')).statusCode).toBe(201) // scp-like form still fine
  })

  it('an invisible agent is not a back door onto its sources', async () => {
    const other = await makeUser('sk-noagent', 'collaborator')
    const S = randomUUID()
    await seedSource(S, { name: 'sk-unreferenced', visibility: 'restricted', sharedWith: [] })
    const A = randomUUID()
    await seedAgent(prisma, A, { visibility: 'restricted', sharedWith: [] })
    await prisma.agent.update({ where: { id: A }, data: { runtimeOverrides: { skills: ['sk-unreferenced/*'] } } })

    const app = appAs(other).app
    expect((await app.inject({ method: 'GET', url: `${ORG}/agents/${A}/skill-sources` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `${ORG}/skill-sources/${S}/skills` })).statusCode).toBe(404)
  })
})

describe('agent call policy endpoint', () => {
  it('uses the existing agent edit gate: collaborator can edit, viewer cannot, invisible target 404s', async () => {
    const collaborator = await makeUser('call-policy-collaborator', 'collaborator')
    const viewer = await makeUser('call-policy-viewer', 'viewer')
    const other = await makeUser('call-policy-other', 'collaborator')
    const targetId = randomUUID()
    const callerId = randomUUID()
    await seedAgent(prisma, targetId, {
      visibility: 'restricted',
      sharedWith: [collaborator, viewer]
    })
    await seedAgent(prisma, callerId, { visibility: 'org' })

    const setPolicy = (userId: string) =>
      appAs(userId).app.inject({
        method: 'PUT',
        url: `${ORG}/agents/${targetId}/call-policy`,
        payload: { callPolicy: 'selected', allowedCallerAgentIds: [callerId] }
      })

    expect((await setPolicy(viewer)).statusCode).toBe(403)
    expect((await setPolicy(other)).statusCode).toBe(404)
    const edited = await setPolicy(collaborator)
    expect(edited.statusCode).toBe(200)
    expect(edited.json()).toMatchObject({
      callPolicy: 'selected',
      allowedCallerAgentIds: [callerId]
    })
  })

  it('preserves a valid hidden caller grant when a collaborator edits visible callers', async () => {
    const owner = await makeUser('call-policy-owner', 'owner')
    const collaborator = await makeUser('call-policy-editor', 'collaborator')
    const targetId = randomUUID()
    const hiddenCallerId = randomUUID()
    const visibleCallerId = randomUUID()
    await seedAgent(prisma, targetId, {
      visibility: 'restricted',
      sharedWith: [collaborator],
      createdByUserId: owner
    })
    await seedAgent(prisma, hiddenCallerId, {
      visibility: 'restricted',
      sharedWith: [],
      createdByUserId: owner
    })
    await seedAgent(prisma, visibleCallerId, { visibility: 'org' })

    const setPolicy = (userId: string, allowedCallerAgentIds: string[]) =>
      appAs(userId).app.inject({
        method: 'PUT',
        url: `${ORG}/agents/${targetId}/call-policy`,
        payload: { callPolicy: 'selected', allowedCallerAgentIds }
      })

    expect((await setPolicy(owner, [hiddenCallerId])).statusCode).toBe(200)
    const edited = await setPolicy(collaborator, [visibleCallerId])
    expect(edited.statusCode).toBe(200)
    expect((edited.json() as { allowedCallerAgentIds: string[] }).allowedCallerAgentIds).toEqual([
      hiddenCallerId,
      visibleCallerId
    ])
  })
})

describe('member removal transfers resource ownership (transactional, §8)', () => {
  it('transfers all five resource types, preserves creator audit, and prunes stale shares', async () => {
    const departingEmail = 'ownership-departing@acme.dev'
    const departing = await makeUser('ownership-departing', 'collaborator')
    const agentId = randomUUID()
    const daemonId = randomUUID()
    const cronId = randomUUID()
    const providerId = randomUUID()
    const sourceId = randomUUID()
    const ownership = {
      visibility: 'restricted' as const,
      sharedWith: [departing],
      createdByUserId: departing,
      ownerUserId: departing
    }

    await seedDaemon(prisma, daemonId, ownership)
    await seedAgent(prisma, agentId, { ...ownership, daemonId })
    await prisma.cronDef.create({
      data: {
        id: cronId,
        orgId: DEFAULT_ORG_ID,
        agentId,
        schedule: '0 * * * *',
        timezone: 'UTC',
        trigger: 'ownership transfer',
        ...ownership
      }
    })
    await prisma.mcpProvider.create({
      data: {
        id: providerId,
        orgId: DEFAULT_ORG_ID,
        name: `ownership-${providerId.slice(0, 8)}`,
        url: 'https://mcp.example.com/sse',
        ...ownership
      }
    })
    await prisma.skillSource.create({
      data: {
        id: sourceId,
        orgId: DEFAULT_ORG_ID,
        name: `ownership-${sourceId.slice(0, 8)}`,
        source: 'example-org/example-kit',
        ...ownership
      }
    })

    const removed = await appAs(DEFAULT_OWNER_ID).app.inject({
      method: 'DELETE',
      url: `${ORG}/members/${departing}`
    })
    expect(removed.statusCode).toBe(204)

    const select = { ownerUserId: true, createdByUserId: true, sharedWith: true } as const
    const rows = await Promise.all([
      prisma.agent.findUniqueOrThrow({ where: { id: agentId }, select }),
      prisma.daemon.findUniqueOrThrow({ where: { id: daemonId }, select }),
      prisma.cronDef.findUniqueOrThrow({ where: { id: cronId }, select }),
      prisma.mcpProvider.findUniqueOrThrow({ where: { id: providerId }, select }),
      prisma.skillSource.findUniqueOrThrow({ where: { id: sourceId }, select })
    ])
    for (const row of rows) {
      expect(row.ownerUserId).toBe(DEFAULT_OWNER_ID)
      expect(row.createdByUserId).toBe(departing)
      expect(row.sharedWith).not.toContain(departing)
    }

    // Re-inviting reuses the same app_user id, but neither old ownership nor an
    // old share grant comes back.
    await users().addMemberByEmail(DEFAULT_ORG_ID, departingEmail, 'collaborator')
    expect((await appAs(departing).app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).statusCode).toBe(404)
    expect(
      (await appAs(DEFAULT_OWNER_ID).app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).statusCode
    ).toBe(200)
  })

  it('serializes removal ahead of a queued resource create so reinviting cannot restore ownership', async () => {
    const sub = `ownership-race-${randomUUID()}`
    const email = `${sub}@acme.dev`
    const departing = await makeUser(sub, 'collaborator')
    const agentName = `ownership-race-${randomUUID().slice(0, 8)}`
    const blockerAgentId = randomUUID()
    await seedAgent(prisma, blockerAgentId, {
      visibility: 'restricted',
      createdByUserId: departing,
      ownerUserId: departing
    })
    const ownerApp = appAs(DEFAULT_OWNER_ID)
    const departingApp = appAs(departing)

    let releaseAgent!: () => void
    let markAgentLocked!: () => void
    const release = new Promise<void>((resolve) => (releaseAgent = resolve))
    const agentLocked = new Promise<void>((resolve) => (markAgentLocked = resolve))
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "agent"
          WHERE "id" = ${blockerAgentId}
          FOR UPDATE
        `
        markAgentLocked()
        await release
      },
      { timeout: 20_000 }
    )
    await agentLocked

    let released = false
    const unlock = () => {
      if (released) return
      released = true
      releaseAgent()
    }
    const waitingLocks = async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*)::bigint AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `
      return Number(rows[0]?.waiting ?? 0n)
    }

    const pending: Promise<unknown>[] = []
    try {
      const removal = ownerApp.app.inject({ method: 'DELETE', url: `${ORG}/members/${departing}` })
      pending.push(removal)
      // Removal has already locked the departing membership FOR UPDATE, then
      // parks while transferring this existing agent row.
      await vi.waitFor(async () => expect(await waitingLocks()).toBeGreaterThanOrEqual(1))

      // This request can still pass org-scope's MVCC read, but its persistence
      // transaction must queue on removal's exclusive membership lock.
      const create = departingApp.app.inject({
        method: 'POST',
        url: `${ORG}/agents`,
        payload: { name: agentName, runtime: 'claude', visibility: 'restricted' }
      })
      pending.push(create)
      await vi.waitFor(async () => expect(await waitingLocks()).toBeGreaterThanOrEqual(2))

      unlock()
      const [removed, created] = await Promise.all([removal, create])
      expect(removed.statusCode).toBe(204)
      expect(created.statusCode).toBe(404)

      await users().addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
      expect(await prisma.agent.findFirst({ where: { orgId: DEFAULT_ORG_ID, name: agentName } })).toBeNull()
      expect(
        (await departingApp.app.inject({ method: 'GET', url: `${ORG}/agents/${blockerAgentId}` })).statusCode
      ).toBe(404)
    } finally {
      unlock()
      await blocker
      await Promise.allSettled(pending)
    }
  })
})

describe('derived visibility — daemon keys inherit the daemon visibility', () => {
  it('a restricted daemon’s keys are hidden from unshared members, including organization owners', async () => {
    const other = await makeUser('k-other', 'collaborator')
    const resourceOwner = await makeUser('k-resource-owner', 'owner')
    const otherOwner = await makeUser('k-other-owner', 'owner')
    const D = randomUUID()
    await seedDaemon(prisma, D, {
      visibility: 'restricted',
      sharedWith: [],
      createdByUserId: resourceOwner
    })

    const otherApp = appAs(other).app
    expect((await otherApp.inject({ method: 'GET', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(404)
    expect((await otherApp.inject({ method: 'POST', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(404)
    expect(
      (await otherApp.inject({ method: 'DELETE', url: `${ORG}/daemons/${D}/keys/${randomUUID()}` })).statusCode
    ).toBe(404)

    const otherOwnerApp = appAs(otherOwner).app
    expect((await otherOwnerApp.inject({ method: 'GET', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(404)
    expect((await otherOwnerApp.inject({ method: 'POST', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(404)

    const resourceOwnerApp = appAs(resourceOwner).app
    expect((await resourceOwnerApp.inject({ method: 'GET', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(200)
    expect((await resourceOwnerApp.inject({ method: 'POST', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(201)
  })
})

describe('reference-write cannot target an invisible agent', () => {
  it('a cron cannot be bound to a restricted agent the caller can’t see (rejected as unknown agentId)', async () => {
    const other = await makeUser('cr-other', 'collaborator')
    const R = randomUUID()
    await seedAgent(prisma, R, { visibility: 'restricted', sharedWith: [] })
    const res = await appAs(other).app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${randomUUID()}`,
      payload: { agentId: R, schedule: '0 0 * * *', trigger: 'daily report', enabled: true }
    })
    expect(res.statusCode).toBe(400) // same verdict as a nonexistent id — no existence oracle
  })
})

describe('reference-write cannot target an invisible daemon', () => {
  it('an agent cannot be placed onto a restricted daemon the caller can’t see (404, same as a nonexistent daemon)', async () => {
    const grantee = await makeUser('da-grantee', 'collaborator')
    const other = await makeUser('da-other', 'collaborator')
    const owner = await makeUser('da-owner', 'owner')
    const D = randomUUID()
    await seedDaemon(prisma, D, { visibility: 'restricted', sharedWith: [grantee] })

    const create = (u: string, name: string) =>
      appAs(u).app.inject({
        method: 'POST',
        url: `${ORG}/agents`,
        payload: { name, runtime: 'claude', daemonId: D }
      })

    // Non-granted collaborator: the restricted daemon reads as absent — same 404 as a
    // nonexistent id, so the endpoint is no existence oracle for restricted daemons.
    expect((await create(other, 'da-agent-other')).statusCode).toBe(404)
    // Only the explicitly shared collaborator can place onto it.
    expect((await create(grantee, 'da-agent-grantee')).statusCode).toBe(201)
    expect((await create(owner, 'da-agent-owner')).statusCode).toBe(404)
  })

  it('an existing agent cannot be moved onto a restricted daemon the caller cannot see', async () => {
    const grantee = await makeUser('move-da-grantee', 'collaborator')
    const other = await makeUser('move-da-other', 'collaborator')
    const D = randomUUID()
    const A = randomUUID()
    await seedDaemon(prisma, D, { visibility: 'restricted', sharedWith: [grantee] })
    await seedAgent(prisma, A, { visibility: 'org' })

    const res = await appAs(other).app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${A}/daemon`,
      payload: { daemonId: D }
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ message: 'daemon not found' })
  })
})

describe('derived visibility — session bodies, usage', () => {
  it('caller-supplied agentId cannot authorize another agent’s session bodies', async () => {
    const other = await makeUser('session-body-other', 'collaborator')
    const daemon = randomUUID()
    await seedDaemon(prisma, daemon)
    const visible = randomUUID()
    const R = randomUUID()
    const session = randomUUID()
    await seedAgent(prisma, visible, { daemonId: daemon })
    await seedAgent(prisma, R, { daemonId: daemon, visibility: 'restricted', sharedWith: [] })
    await prisma.sessionMeta.create({
      data: {
        id: session,
        agentId: R,
        orgId: DEFAULT_ORG_ID,
        platform: 'slack',
        channel: 'C-HR',
        phase: 'start',
        lastActivityAt: new Date()
      }
    })

    const app = appAs(other).app
    for (const path of [
      `/sessions/${session}/messages?agentId=${visible}`,
      `/sessions/${session}/tool-body?agentId=${visible}&toolCallId=t1`
    ]) {
      expect((await app.inject({ method: 'GET', url: `${ORG}${path}` })).statusCode).toBe(404)
    }
  })

  it('a restricted agent’s usage is absent from every unshared member’s aggregate, including owners', async () => {
    const other = await makeUser('u-other', 'collaborator')
    const owner = await makeUser('u-owner', 'owner')
    const R = randomUUID()
    await seedAgent(prisma, R, { visibility: 'restricted', sharedWith: [] })
    await prisma.sessionUsage.create({
      data: { agentId: R, sessionId: 'acp-1', totalTokens: 1234, lastActivityAt: new Date() }
    })

    const usageAgents = async (u: string): Promise<string[]> => {
      const res = await appAs(u).app.inject({ method: 'GET', url: `${ORG}/usage?range=d30` })
      return (res.json() as { agents: Array<{ agentId: string }> }).agents.map((a) => a.agentId)
    }
    expect(await usageAgents(other)).not.toContain(R)
    expect(await usageAgents(owner)).not.toContain(R)
  })
})

describe('atomic restricted-create (visibility + sharedWith in the create body)', () => {
  it('POST /agents creates restricted in one call; sharedWith is intersected with members', async () => {
    const owner = await makeUser('ac-owner', 'owner')
    const member = await makeUser('ac-member', 'collaborator')
    const other = await makeUser('ac-other', 'collaborator')
    const daemon = randomUUID()
    await seedDaemon(prisma, daemon)

    const res = await appAs(owner).app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'restricted-at-birth',
        runtime: 'claude',
        daemonId: daemon,
        visibility: 'restricted',
        sharedWith: [member, 'ghost-not-a-member'] // ghost dropped by the member intersect
      }
    })
    expect(res.statusCode).toBe(201)
    const created = res.json() as { id: string; visibility: string; sharedWith: string[] }
    expect(created.visibility).toBe('restricted')
    expect(created.sharedWith).toEqual([member])

    // Hidden from a non-granted collaborator, visible to the granted member.
    expect((await appAs(other).app.inject({ method: 'GET', url: `${ORG}/agents/${created.id}` })).statusCode).toBe(404)
    expect((await appAs(member).app.inject({ method: 'GET', url: `${ORG}/agents/${created.id}` })).statusCode).toBe(200)
  })

  it('PUT /crons creates restricted in one call; a later content edit never flips sharing', async () => {
    const owner = await makeUser('acc-owner', 'owner')
    const member = await makeUser('acc-member', 'collaborator')
    const daemon = randomUUID()
    await seedDaemon(prisma, daemon)
    const agent = randomUUID()
    await seedAgent(prisma, agent, { daemonId: daemon })
    const cronId = randomUUID()

    const create = await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: {
        agentId: agent,
        schedule: '0 9 * * *',
        trigger: 'daily',
        enabled: true,
        visibility: 'restricted',
        sharedWith: [member]
      }
    })
    expect(create.statusCode).toBe(200)
    expect((create.json() as { visibility: string; sharedWith: string[] }).visibility).toBe('restricted')
    expect((create.json() as { sharedWith: string[] }).sharedWith).toEqual([member])

    // An EDIT carrying visibility:'org' in the CONTENT body must NOT change sharing —
    // that only moves through PUT /crons/:id/sharing.
    const edit = await appAs(owner).app.inject({
      method: 'PUT',
      url: `${ORG}/crons/${cronId}`,
      payload: {
        agentId: agent,
        schedule: '0 10 * * *',
        trigger: 'daily',
        enabled: true,
        visibility: 'org',
        sharedWith: []
      }
    })
    expect(edit.statusCode).toBe(200)
    expect((edit.json() as { visibility: string }).visibility).toBe('restricted')
  })
})
