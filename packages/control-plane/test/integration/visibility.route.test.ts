/**
 * Per-resource visibility enforcement (docs/designs/resource-visibility.md).
 *
 * Under devAuth the principal is fixed to `DEFAULT_OWNER_ID`, so we act "as" a
 * given user by building a second app with `{ DEFAULT_OWNER_ID: userId }`. Users
 * are provisioned + added to the default org with a role; agents are seeded with
 * a visibility + share set. Every request runs through the real HTTP stack.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
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
  it('a restricted agent is hidden from a non-granted collaborator but visible to creator, grantee, and owner', async () => {
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

    // Creator, grantee, and owner all see it.
    for (const u of [creator, grantee, owner]) {
      const res = await appAs(u).app.inject({ method: 'GET', url: `${ORG}/agents/${R}` })
      expect(res.statusCode).toBe(200)
      expect(agentIds((await appAs(u).app.inject({ method: 'GET', url: `${ORG}/agents` })).json())).toContain(R)
    }
  })

  it('the list SQL filter and the canView predicate agree (no leak, no false hide)', async () => {
    const grantee = await makeUser('agree-grantee', 'collaborator')
    const other = await makeUser('agree-other', 'collaborator')
    await seedAgent(prisma, randomUUID(), { visibility: 'org' }) // everyone
    await seedAgent(prisma, randomUUID(), { visibility: 'restricted', sharedWith: [grantee] }) // grantee only
    await seedAgent(prisma, randomUUID(), { visibility: 'restricted', sharedWith: [] }) // owners/creator only

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
  it('a shared collaborator can re-share, a shared viewer cannot, a non-viewer 404s, owner can', async () => {
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
    expect((await share(owner, [grantee, other])).statusCode).toBe(200) // governance override can manage
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
    opts: { name: string; visibility?: 'org' | 'restricted'; sharedWith?: string[]; createdByUserId?: string }
  ): Promise<void> {
    await prisma.mcpProvider.create({
      data: {
        id,
        orgId: DEFAULT_ORG_ID,
        name: opts.name,
        url: 'https://mcp.example.com/sse',
        ...(opts.visibility ? { visibility: opts.visibility } : {}),
        ...(opts.sharedWith ? { sharedWith: opts.sharedWith } : {}),
        ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {})
      }
    })
  }

  it('a restricted provider is hidden from a non-granted collaborator but visible to creator, grantee, owner', async () => {
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
    for (const u of [creator, grantee, owner]) {
      expect((await appAs(u).app.inject({ method: 'GET', url: `${MCP}/${P}` })).statusCode).toBe(200)
    }
  })

  it('PUT /mcp-providers/:id/sharing gates on canManageSharing; a non-viewer 404s, owner can widen', async () => {
    const owner = await makeUser('mcp-sh-owner', 'owner')
    const member = await makeUser('mcp-sh-member', 'collaborator')
    const other = await makeUser('mcp-sh-other', 'collaborator')
    const P = randomUUID()
    await seedProvider(P, { name: 'mcp-sh', visibility: 'restricted', sharedWith: [] })

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

  it('the enable-list gate: a user may DISABLE an unseen provider but cannot ADD it back; an owner can', async () => {
    const owner = await makeUser('mcp-en-owner', 'owner')
    const other = await makeUser('mcp-en-other', 'collaborator')
    const daemon = randomUUID()
    await seedDaemon(prisma, daemon)
    await seedProvider(randomUUID(), { name: 'mcp-hidden', visibility: 'restricted', sharedWith: [] })
    const A = randomUUID()
    await seedAgent(prisma, A, { daemonId: daemon, visibility: 'org' })
    // Pre-enable the hidden provider on the agent (the enable-list lives in runtimeOverrides).
    await prisma.agent.update({ where: { id: A }, data: { runtimeOverrides: { mcpServers: ['mcp-hidden'] } } })

    const patchMcp = (u: string, mcpServers: string[]) =>
      appAs(u).app.inject({ method: 'PATCH', url: `${ORG}/agents/${A}`, payload: { mcpServers } })

    expect((await patchMcp(other, [])).statusCode).toBe(200) // disable: removal-only, allowed
    expect((await patchMcp(other, ['mcp-hidden'])).statusCode).toBe(403) // add back an unseen provider: denied
    expect((await patchMcp(owner, ['mcp-hidden'])).statusCode).toBe(200) // owner sees everything: allowed
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
      sharedWith: [collaborator]
    })
    await seedAgent(prisma, hiddenCallerId, { visibility: 'restricted', sharedWith: [] })
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

describe('member removal prunes the share set (transactional, §8.1)', () => {
  it('removing a member strips their id from every resource sharedWith', async () => {
    const grantee = await makeUser('prune-grantee', 'collaborator')
    const R = randomUUID()
    await seedAgent(prisma, R, { visibility: 'restricted', sharedWith: [grantee] })

    await new PgUserRepo(prisma).removeMember(DEFAULT_ORG_ID, grantee)

    const row = await prisma.agent.findUnique({ where: { id: R }, select: { sharedWith: true } })
    expect(row!.sharedWith).not.toContain(grantee)
  })
})

describe('derived visibility — daemon keys inherit the daemon visibility', () => {
  it('a non-viewer 404s on list / mint / revoke of a restricted daemon’s keys; an owner can', async () => {
    const other = await makeUser('k-other', 'collaborator')
    const owner = await makeUser('k-owner', 'owner')
    const D = randomUUID()
    await seedDaemon(prisma, D, { visibility: 'restricted', sharedWith: [] })

    const otherApp = appAs(other).app
    expect((await otherApp.inject({ method: 'GET', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(404)
    expect((await otherApp.inject({ method: 'POST', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(404)
    expect(
      (await otherApp.inject({ method: 'DELETE', url: `${ORG}/daemons/${D}/keys/${randomUUID()}` })).statusCode
    ).toBe(404)

    // The owner (governance override) still manages the restricted daemon's keys.
    expect((await appAs(owner).app.inject({ method: 'GET', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(200)
    expect((await appAs(owner).app.inject({ method: 'POST', url: `${ORG}/daemons/${D}/keys` })).statusCode).toBe(201)
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
    // Shared collaborator and owner (governance override) can place onto it.
    expect((await create(grantee, 'da-agent-grantee')).statusCode).toBe(201)
    expect((await create(owner, 'da-agent-owner')).statusCode).toBe(201)
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

describe('derived visibility — sessions tool-body, usage', () => {
  it('tool-body 404s for a restricted agent the caller can’t see', async () => {
    const other = await makeUser('tb-other', 'collaborator')
    const daemon = randomUUID()
    await seedDaemon(prisma, daemon)
    const R = randomUUID()
    await seedAgent(prisma, R, { daemonId: daemon, visibility: 'restricted', sharedWith: [] })
    const res = await appAs(other).app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${randomUUID()}/tool-body?agentId=${R}&toolCallId=t1`
    })
    expect(res.statusCode).toBe(404)
  })

  it('a restricted agent’s usage is absent from a non-viewer’s aggregate but present for an owner', async () => {
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
    expect(await usageAgents(owner)).toContain(R)
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
