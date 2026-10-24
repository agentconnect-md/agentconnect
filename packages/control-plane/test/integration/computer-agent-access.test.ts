// Agent access to a Computer as one relation (computer-use.md §4.1), set from the Computer or from the agent's side.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSpec, AgentUpsert, CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { ComputerChannelGrants } from '../../src/registry/computerChannelGrants.js'
import { ComputerChannelKeys } from '../../src/registry/computerChannelKeys.js'
import { PgComputerRepo } from '../../src/persistence/repositories/computer.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { defaultComputerPolicy } from '../../src/domain/computer.js'
import { ComputerId, OrgId } from '../../src/domain/ids.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const NONE = { mode: 'none', agents: [] }

class SpyControl {
  readonly upserts: AgentUpsert[] = []
  async agentUpsert(_daemonId: string, u: AgentUpsert): Promise<void> {
    this.upserts.push(u)
  }
  async agentRemove(): Promise<void> {}
  async collaborationRoutes(_daemonId: string, _snapshot: CollabRoutesSnapshot): Promise<void> {}
  /** The spec last pushed for an agent. */
  specOf(agentId: string): AgentSpec | undefined {
    return this.upserts.filter((u) => u.agentId === agentId).at(-1)?.spec
  }
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function appAs(userId: string = DEFAULT_OWNER_ID): { app: HttpApp; spy: SpyControl } {
  const spy = new SpyControl()
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, undefined, spy as unknown as ControlSender)
  opened.push(app)
  return { app, spy }
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@acme.dev`
  const { userId } = await new PgUserRepo(prisma).provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function register(app: HttpApp): Promise<string> {
  const minted = await app.app.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: {} })
  expect(minted.statusCode).toBe(201)
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/v1/computers/register',
    payload: {
      token: (minted.json() as { token: string }).token,
      name: 'ubuntu-desk',
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

async function placedAgents(...names: string[]): Promise<string[]> {
  if (!(await prisma.daemon.findUnique({ where: { id: DAEMON } }))) await seedDaemon(prisma, DAEMON)
  const ids: string[] = []
  for (const name of names) {
    const id = randomUUID()
    await seedAgent(prisma, id, { daemonId: DAEMON, name })
    ids.push(id)
  }
  return ids
}

const grants = new ComputerChannelGrants(
  new PgComputerRepo(prisma),
  new ComputerChannelKeys(TEST_API_KEY_PEPPER, 300),
  systemClock,
  { staleAfterMs: 45_000, relays: async () => [] }
)
// The CP's own data-plane check: `denied` means no access; an offline Computer with access is `unavailable`.
const grantCode = async (computerId: string, agentId: string) => {
  const result = await grants.grant(OrgId(DEFAULT_ORG_ID), computerId, { agentId, sessionId: 's1', daemonId: DAEMON })
  return result.granted ? 'granted' : result.code
}

// A manual pool computer, visible to the organization and edited by any editor.
async function manualComputer(): Promise<string> {
  const created = await new PgComputerRepo(prisma).createManaged({
    id: ComputerId(randomUUID()),
    orgId: OrgId(DEFAULT_ORG_ID),
    name: 'Shared browser',
    ownerUserId: DEFAULT_OWNER_ID,
    allocation: 'manual',
    policy: defaultComputerPolicy(DEFAULT_OWNER_ID),
    agentAccess: { mode: 'none', agents: [] },
    now: new Date()
  })
  return created!.id
}

const revisionOf = async (agentId: string) =>
  (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).configRevision

describe('agent access to a Computer (computer-use.md §4.1)', () => {
  it('a new Computer admits no agent, so no agent gets the tools', async () => {
    const [a] = await placedAgents('access-a')
    const { app } = appAs()
    const computerId = await register(app)
    const read = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(read.json()).toMatchObject({ agentAccess: NONE, canEditAgentAccess: true })
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/agents/${a}` })).json().computerUse).toBeNull()
    expect(await grantCode(computerId, a!)).toBe('denied')
  })

  it('selecting an agent on the Computer gives it the tools without visiting the agent', async () => {
    const [a, b] = await placedAgents('access-a', 'access-b')
    const { app, spy } = appAs()
    const computerId = await register(app)
    const before = await revisionOf(a!)

    const res = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/agent-access`,
      payload: { mode: 'selected', agents: [a, a] }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().agentAccess).toEqual({ mode: 'selected', agents: [a] })

    // The agent's spec is re-shipped with the Computer at a new revision, so the daemon applies it.
    expect(spy.specOf(a!)?.computerUse).toEqual({ enabled: true, computers: [computerId] })
    expect(spy.specOf(b!)).toBeUndefined()
    expect(await revisionOf(a!)).toBe(before + 1n)
    const agent = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${a}` })
    expect(agent.json().computerUse).toEqual({ enabled: true, computers: [computerId] })
    expect(await grantCode(computerId, a!)).toBe('unavailable')
    expect(await grantCode(computerId, b!)).toBe('denied')

    const audit = await prisma.auditEvent.findMany({ where: { kind: 'computer_change' } })
    expect(audit.map((e) => e.details)).toContainEqual(
      expect.objectContaining({ action: 'agent_access_update', computerId, after: { mode: 'selected', agents: [a] } })
    )
  })

  it('adding the Computer from the agent’s side shows the agent on the Computer, and removing it leaves the agent alone', async () => {
    const [a, b] = await placedAgents('access-a', 'access-b')
    await prisma.agent.update({
      where: { id: a! },
      data: { runtimeOverrides: { computerUse: { managed: { mode: 'per-agent' } } } }
    })
    const { app, spy } = appAs()
    const computerId = await register(app)

    const add = (agentId: string) =>
      app.app.inject({ method: 'PUT', url: `${ORG}/computers/${computerId}/agent-access/agents/${agentId}` })
    const remove = (agentId: string) =>
      app.app.inject({ method: 'DELETE', url: `${ORG}/computers/${computerId}/agent-access/agents/${agentId}` })

    expect((await add(a!)).json().agentAccess).toEqual({ mode: 'selected', agents: [a] })
    expect((await add(a!)).json().agentAccess).toEqual({ mode: 'selected', agents: [a] })
    expect((await add(b!)).json().agentAccess).toEqual({ mode: 'selected', agents: [a, b] })
    const computer = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(computer.json().agentAccess.agents).toEqual([a, b])
    expect(spy.specOf(b!)?.computerUse).toEqual({ enabled: true, computers: [computerId] })

    expect((await remove(b!)).json().agentAccess).toEqual({ mode: 'selected', agents: [a] })
    expect(spy.specOf(b!)?.computerUse).toBeNull()
    // The last one out leaves the Computer at none; the agent keeps its own managed setting.
    expect((await remove(a!)).json().agentAccess).toEqual(NONE)
    expect(spy.specOf(a!)?.computerUse).toEqual({ enabled: true, computers: [], managed: { mode: 'per-agent' } })
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: a! } })
    expect(stored.runtimeOverrides).toEqual({ computerUse: { managed: { mode: 'per-agent' } } })
    expect((await add(randomUUID())).statusCode).toBe(400)
  })

  it('All agents gives every agent the tools, and an agent’s removal narrows it to every other agent', async () => {
    const [a, b] = await placedAgents('access-a', 'access-b')
    const { app, spy } = appAs()
    const computerId = await register(app)
    const all = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/agent-access`,
      payload: { mode: 'all', agents: [] }
    })
    expect(all.json().agentAccess).toEqual({ mode: 'all', agents: [] })
    for (const id of [a!, b!]) {
      expect(spy.specOf(id)?.computerUse).toEqual({ enabled: true, computers: [computerId] })
      expect(await grantCode(computerId, id)).toBe('unavailable')
    }
    // A new agent is covered too, from its first spec.
    const [c] = await placedAgents('access-c')
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/agents/${c}` })).json().computerUse).toEqual({
      enabled: true,
      computers: [computerId]
    })
    const one = `${ORG}/computers/${computerId}/agent-access/agents/${a}`
    const added = await app.app.inject({ method: 'PUT', url: one })
    expect(added.statusCode).toBe(200)
    expect(added.json().agentAccess).toEqual({ mode: 'all', agents: [] })
    const removed = await app.app.inject({ method: 'DELETE', url: one })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().agentAccess.mode).toBe('selected')
    expect([...removed.json().agentAccess.agents].sort()).toEqual([b!, c!].sort())
    expect(spy.specOf(a!)?.computerUse ?? null).toBeNull()
    expect(spy.specOf(b!)?.computerUse).toEqual({ enabled: true, computers: [computerId] })

    // Revoking the Computer takes it off every agent's list.
    await app.app.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/revoke` })
    expect(spy.specOf(b!)?.computerUse).toBeNull()
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/agents/${a}` })).json().computerUse).toBeNull()
  })

  it('any editor it is visible to gives a desktop to an agent, and only its registrant sets the whole access', async () => {
    const [a] = await placedAgents('access-a')
    const viewer = await makeUser('access-viewer', 'viewer')
    const carol = await makeUser('access-carol', 'collaborator')
    const { app: owner } = appAs()
    const computerId = await register(owner)
    const put = (app: HttpApp) =>
      app.app.inject({
        method: 'PUT',
        url: `${ORG}/computers/${computerId}/agent-access`,
        payload: { mode: 'selected', agents: [a] }
      })
    const add = (app: HttpApp) =>
      app.app.inject({ method: 'PUT', url: `${ORG}/computers/${computerId}/agent-access/agents/${a}` })

    // A self-hosted desktop starts Selected for its registrant: another member cannot see it.
    expect((await put(appAs(carol).app)).statusCode).toBe(404)
    expect((await add(appAs(carol).app)).statusCode).toBe(404)
    const shared = await owner.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/sharing`,
      payload: { visibility: 'org', sharedWith: [] }
    })
    expect(shared.statusCode).toBe(200)
    expect((await put(appAs(viewer).app)).statusCode).toBe(403)
    expect((await add(appAs(viewer).app)).statusCode).toBe(403)
    const read = await appAs(viewer).app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(read.json().canEditAgentAccess).toBe(false)
    // A desktop shared with a collaborator is theirs to give their agents, one at a time; All agents stays the registrant's.
    expect((await put(appAs(carol).app)).statusCode).toBe(403)
    const seen = await appAs(carol).app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(seen.json().canEditAgentAccess).toBe(true)
    const carolGives = await add(appAs(carol).app)
    expect(carolGives.statusCode).toBe(200)
    expect(carolGives.json().agentAccess).toEqual({ mode: 'selected', agents: [a] })
    expect((await put(owner)).statusCode).toBe(200)
    // A manual pool computer takes any editor's change, as with visibility.
    const manual = await manualComputer()
    const carolAdds = await appAs(carol).app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${manual}/agent-access/agents/${a}`
    })
    expect(carolAdds.statusCode).toBe(200)
  })

  it('a removed member’s desktop leaves the specs of the agents it granted, at a new revision', async () => {
    const [a] = await placedAgents('access-a')
    const carol = await makeUser('access-carol', 'collaborator')
    const { app: carolApp } = appAs(carol)
    const computerId = await register(carolApp)
    const add = await carolApp.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/agent-access/agents/${a}`
    })
    expect(add.statusCode).toBe(200)
    const before = await revisionOf(a!)
    const { app: owner, spy } = appAs()
    expect((await owner.app.inject({ method: 'DELETE', url: `${ORG}/members/${carol}` })).statusCode).toBe(204)
    expect(await revisionOf(a!)).toBeGreaterThan(before)
    expect(spy.specOf(a!)).toBeDefined()
    expect(spy.specOf(a!)?.computerUse ?? null).toBeNull()
  })

  it('a Selected list stops at the cap, and a deleted agent leaves it', async () => {
    const [a, b] = await placedAgents('access-a', 'access-b')
    const { app } = appAs()
    const computerId = await register(app)
    const dead = Array.from({ length: 199 }, () => randomUUID())
    await prisma.computer.update({
      where: { id: computerId },
      data: { agentAccess: 'selected', accessAgentIds: [...dead, a!] }
    })
    const add = (agentId: string) =>
      app.app.inject({ method: 'PUT', url: `${ORG}/computers/${computerId}/agent-access/agents/${agentId}` })
    expect((await add(b!)).statusCode).toBe(409)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/computers` })).statusCode).toBe(200)
    // Ids of agents that no longer exist are not kept as hidden on a whole-value write.
    const put = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/agent-access`,
      payload: { mode: 'selected', agents: [a, b] }
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().agentAccess).toEqual({ mode: 'selected', agents: [a, b] })
    // Deleting an agent takes it off every list; the last one gone leaves None.
    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${a}` })).statusCode).toBe(204)
    const afterA = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(afterA.json().agentAccess).toEqual({ mode: 'selected', agents: [b] })
    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${b}` })).statusCode).toBe(204)
    const afterB = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${computerId}` })
    expect(afterB.json().agentAccess).toEqual(NONE)
  })

  it('a collaborator’s edit keeps the agents they cannot see', async () => {
    const carol = await makeUser('access-carol', 'collaborator')
    await seedDaemon(prisma, DAEMON)
    const hidden = randomUUID()
    const visible = randomUUID()
    await seedAgent(prisma, hidden, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] })
    await seedAgent(prisma, visible, { daemonId: DAEMON })
    const { app: owner } = appAs()
    const computerId = await manualComputer()
    const set = (app: HttpApp, agents: string[]) =>
      app.app.inject({
        method: 'PUT',
        url: `${ORG}/computers/${computerId}/agent-access`,
        payload: { mode: 'selected', agents }
      })
    expect((await set(owner, [hidden])).statusCode).toBe(200)
    const { app: collaborator } = appAs(carol)
    expect((await set(collaborator, [hidden, visible])).statusCode).toBe(200)
    const edited = await set(collaborator, [visible])
    expect(edited.json().agentAccess).toEqual({ mode: 'selected', agents: [hidden, visible] })
    // A newly listed agent must be one the caller can see.
    const other = randomUUID()
    await seedAgent(prisma, other, { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] })
    expect((await set(collaborator, [visible, other])).statusCode).toBe(400)
  })

  it('a per-agent computer is used only by its own agent, and a manual one takes access like any other', async () => {
    const [a, b] = await placedAgents('access-a', 'access-b')
    const { app, spy } = appAs()
    const repo = new PgComputerRepo(prisma)
    const perAgent = await repo.createManaged({
      id: ComputerId(randomUUID()),
      orgId: OrgId(DEFAULT_ORG_ID),
      name: 'A desktop',
      ownerUserId: DEFAULT_OWNER_ID,
      allocation: 'per-agent',
      ownerAgentId: a!,
      policy: defaultComputerPolicy(DEFAULT_OWNER_ID),
      agentAccess: { mode: 'selected', agents: [a!] },
      now: new Date()
    })
    const read = await app.app.inject({ method: 'GET', url: `${ORG}/computers/${perAgent!.id}` })
    expect(read.json()).toMatchObject({ agentAccess: { mode: 'selected', agents: [a] }, canEditAgentAccess: false })
    const widen = await app.app.inject({
      method: 'PUT',
      url: `${ORG}/computers/${perAgent!.id}/agent-access`,
      payload: { mode: 'all', agents: [] }
    })
    expect(widen.statusCode).toBe(409)
    expect(await grantCode(perAgent!.id, a!)).toBe('unavailable')
    expect(await grantCode(perAgent!.id, b!)).toBe('denied')
    // It is reached through the agent's managed mode, never listed among its Computers.
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/agents/${a}` })).json().computerUse).toBeNull()

    const manual = await repo.createManaged({
      id: ComputerId(randomUUID()),
      orgId: OrgId(DEFAULT_ORG_ID),
      name: 'Shared browser',
      ownerUserId: DEFAULT_OWNER_ID,
      allocation: 'manual',
      policy: defaultComputerPolicy(DEFAULT_OWNER_ID),
      agentAccess: NONE as { mode: 'none'; agents: string[] },
      now: new Date()
    })
    const add = await app.app.inject({ method: 'PUT', url: `${ORG}/computers/${manual!.id}/agent-access/agents/${b}` })
    expect(add.statusCode).toBe(200)
    expect(spy.specOf(b!)?.computerUse).toEqual({ enabled: true, computers: [manual!.id] })
  })
})
