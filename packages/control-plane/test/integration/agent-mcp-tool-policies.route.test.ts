// Per-agent MCP tool policy routes: RBAC, interactive-only writes, grant lifecycle and lifecycle cascades (mcp-tool-permissions.md §5).
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentUpsert, McpServerSpec, RcMcpAssign, RcMcpUnassign } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { encodeAgentSpecForPeer } from '../../src/domain/daemon-features.js'
import { grantKeyHash } from '../../src/orchestrator/mcpProvider.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const CAPABLE = 'd0000000-0000-4000-8000-00000000c001'
const OLDER = 'd0000000-0000-4000-8000-00000000c002'
const APPROVER = 'd0000000-0000-4000-8000-00000000c003'
const READ_ONLY = { groups: { readOnly: 'allow', write: 'block', other: 'block' }, overrides: {} }

/** Records the daemon-bound frames, mirroring the real sender's per-peer spec encoding. */
class PolicySpyControl {
  readonly features = new Map<string, string[]>([
    [CAPABLE, ['mcp-agent-defs-v1']],
    [APPROVER, ['mcp-agent-defs-v1', 'mcp-tool-approval-v1']]
  ])
  readonly events: string[] = []
  readonly upserts: Array<{ daemonId: string; spec: McpServerSpec }> = []
  readonly removes: Array<{ daemonId: string; name: string; agentId?: string }> = []
  readonly specs: Array<{ daemonId: string; mcpServers: string[] }> = []
  readonly revisions: string[] = []
  daemonFeatures(daemonId: string): readonly string[] | undefined {
    return this.features.get(daemonId)
  }
  async agentUpsert(daemonId: string, u: AgentUpsert): Promise<void> {
    this.specs.push({ daemonId, mcpServers: encodeAgentSpecForPeer(u.spec, this.daemonFeatures(daemonId)).mcpServers })
    if (u.spec.configRevision !== undefined) this.revisions.push(u.spec.configRevision)
  }
  async agentRemove(): Promise<void> {}
  async mcpServerUpsert(daemonId: string, spec: McpServerSpec): Promise<void> {
    this.events.push(`upsert:${daemonId}:${spec.agentId ?? 'shared'}`)
    this.upserts.push({ daemonId, spec })
  }
  async mcpServerRemove(daemonId: string, _orgId: string, name: string, agentId?: string): Promise<void> {
    this.events.push(`remove:${daemonId}:${agentId ?? 'shared'}`)
    this.removes.push({ daemonId, name, ...(agentId ? { agentId } : {}) })
  }
}

type RelayFrame = { type: string; payload: unknown }

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function makeApp(opts: { userId?: string; control?: PolicySpyControl; relayFeatures?: string[] } = {}) {
  const control = opts.control ?? new PolicySpyControl()
  const app = buildHttpApp(
    prisma,
    { RELAY_STALE_MS: 60_000, ...(opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {}) },
    undefined,
    control as unknown as ControlSender
  )
  opened.push(app)
  const frames: RelayFrame[] = []
  app.relayReg.add({
    relayId: `relay-${randomUUID()}`,
    features: opts.relayFeatures ?? ['mcp-tool-policy-v1'],
    send: (type, payload) => {
      frames.push({ type, payload })
      control.events.push(`relay:${type}`)
    },
    close: () => {}
  })
  return { app, control, frames }
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@example.test`
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** A provider with its shared grant, a live relay row, and agents placed on daemons. */
async function seedWorld(app: HttpApp, name = 'docs') {
  await prisma.relay.create({
    data: { id: randomUUID(), name: 'relay-1', daemonUrl: 'ws://relay.example.test:8443', lastSeenAt: new Date() }
  })
  const created = await app.app.inject({
    method: 'POST',
    url: `${ORG}/mcp-providers`,
    payload: { name, url: 'https://mcp.example.test/mcp' }
  })
  expect(created.statusCode).toBe(201)
  // The create's catalog refresh finds no relay that can answer, and must land before a test writes the snapshot.
  await app.deps.mcpToolCatalog!.settle()
  return created.json() as { id: string; grantKey: string }
}

async function placedAgent(daemonId: string, mcpServers: string[]): Promise<string> {
  const id = randomUUID()
  await seedAgent(prisma, id, { daemonId, runtimeOverrides: { mcpServers } })
  return id
}

const policyUrl = (agentId: string, providerId: string) => `${ORG}/agents/${agentId}/mcp-tool-policies/${providerId}`

const lastAssign = (frames: RelayFrame[]) =>
  frames.filter((f) => f.type === 'rc/mcp-assign').at(-1)!.payload as RcMcpAssign

describe('agent MCP tool policies — authorization', () => {
  it('refuses a viewer, a member who cannot see the agent or the provider, and an API key', async () => {
    const owner = makeApp()
    const provider = await seedWorld(owner.app)
    await seedDaemon(prisma, CAPABLE)
    const agentId = await placedAgent(CAPABLE, ['docs'])

    const viewer = makeApp({ userId: await makeUser('policy-viewer', 'viewer') })
    const refused = await viewer.app.app.inject({
      method: 'PUT',
      url: policyUrl(agentId, provider.id),
      payload: READ_ONLY
    })
    expect(refused.statusCode).toBe(403)
    // Reading needs only the agent's visibility.
    const read = await viewer.app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/mcp-tool-policies` })
    expect(read.statusCode).toBe(200)

    const collaborator = makeApp({ userId: await makeUser('policy-member', 'collaborator') })
    const hidden = await placedAgent(CAPABLE, ['docs'])
    await prisma.agent.update({
      where: { id: hidden },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const unseenAgent = await collaborator.app.app.inject({
      method: 'PUT',
      url: policyUrl(hidden, provider.id),
      payload: READ_ONLY
    })
    expect(unseenAgent.statusCode).toBe(404)
    await prisma.mcpProvider.update({
      where: { id: provider.id },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const unseenProvider = await collaborator.app.app.inject({
      method: 'PUT',
      url: policyUrl(agentId, provider.id),
      payload: READ_ONLY
    })
    expect(unseenProvider.statusCode).toBe(404)

    const key = (
      await owner.app.app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
    ).json() as { apiKey: string }
    const headers = { authorization: `Bearer ${key.apiKey}` }
    for (const method of ['PUT', 'DELETE'] as const) {
      const res = await owner.app.app.inject({
        method,
        url: policyUrl(agentId, provider.id),
        headers,
        ...(method === 'PUT' ? { payload: READ_ONLY } : {})
      })
      expect(res.statusCode, method).toBe(403)
      expect(res.json().message).toBe('interactive sign-in required')
    }
    expect(await prisma.agentMcpToolPolicy.count()).toBe(0)
  })

  it('validates override names and counts', async () => {
    const { app } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, OLDER)
    const agentId = await placedAgent(OLDER, [])
    const long = await app.app.inject({
      method: 'PUT',
      url: policyUrl(agentId, provider.id),
      payload: { ...READ_ONLY, overrides: { ['x'.repeat(257)]: 'allow' } }
    })
    expect(long.statusCode).toBe(400)
    const many = await app.app.inject({
      method: 'PUT',
      url: policyUrl(agentId, provider.id),
      payload: {
        ...READ_ONLY,
        overrides: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`t${i}`, 'allow']))
      }
    })
    expect(many.statusCode).toBe(400)
  })
})

describe('agent MCP tool policies — grant lifecycle', () => {
  it('a first save mints the agent grant, binds it on the relay before the daemon definition, and expands the catalog', async () => {
    const { app, control, frames } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, CAPABLE)
    await seedDaemon(prisma, OLDER)
    const restricted = await placedAgent(CAPABLE, ['docs'])
    const onOlder = await placedAgent(OLDER, ['docs'])
    await app.deps.repos.mcpToolCatalog.put(OrgId(DEFAULT_ORG_ID), provider.id, {
      tools: [
        { name: 'search', readOnlyHint: true, interactive: false },
        { name: 'create', readOnlyHint: false, interactive: false },
        { name: 'misc', interactive: false }
      ],
      fetchedAt: new Date('2026-11-20T00:00:00Z'),
      failure: null
    })
    control.events.length = 0
    frames.length = 0

    const saved = await app.app.inject({ method: 'PUT', url: policyUrl(restricted, provider.id), payload: READ_ONLY })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({
      providerId: provider.id,
      providerName: 'docs',
      allowTools: ['search'],
      approvalTools: [],
      askTools: [],
      catalogFetchedAt: '2026-11-20T00:00:00.000Z',
      drift: { newTools: [], changedTools: [], missingTools: [] }
    })

    const grants = await prisma.mcpGrant.findMany({ where: { agentId: restricted } })
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ custody: 'runtime', status: 'active', mcpProviderId: provider.id })
    const [agentGrant] = await app.deps.repos.mcpGrant.activeForAgent(OrgId(DEFAULT_ORG_ID), provider.id, restricted)
    // The shared slot is untouched: activeForProvider still lists only the organization's grant.
    expect(
      (await app.deps.repos.mcpGrant.activeForProvider(OrgId(DEFAULT_ORG_ID), provider.id)).map((g) => g.key)
    ).toEqual([provider.grantKey])

    // The relay binding lands before the daemon definition that carries the new key.
    expect(control.events.indexOf('relay:rc/mcp-assign')).toBeLessThan(
      control.events.indexOf(`upsert:${CAPABLE}:${restricted}`)
    )
    const assign = lastAssign(frames)
    expect(assign.grantKeyHashes).toEqual([grantKeyHash(provider.grantKey)])
    expect(assign.toolPolicies).toEqual([{ allow: ['search'], approval: [], ask: [] }])
    expect(assign.restrictedGrants).toEqual([{ grantKeyHash: grantKeyHash(agentGrant!.key), policy: 0 }])

    // The capable daemon gets the agent's own definition and loses the unneeded shared one.
    const own = control.upserts.find((u) => u.spec.agentId === restricted)!
    expect(own.daemonId).toBe(CAPABLE)
    expect(own.spec.headers).toEqual([{ name: 'Authorization', value: `Bearer ${agentGrant!.key}` }])
    expect(own.spec.toolDecisions).toEqual({ allow: ['search'], approval: [], ask: [], block: ['create', 'misc'] })
    expect(control.removes).toContainEqual({ daemonId: CAPABLE, name: 'docs' })
    // The older daemon's agent is unrestricted and keeps everything.
    expect(control.upserts.some((u) => u.daemonId === OLDER && u.spec.agentId)).toBe(false)
    expect(control.removes.some((r) => r.daemonId === OLDER)).toBe(false)
    expect(onOlder).toBeDefined()

    // A second save changes the table, not the key.
    const again = await app.app.inject({
      method: 'PUT',
      url: policyUrl(restricted, provider.id),
      payload: { ...READ_ONLY, overrides: { create: 'allow' } }
    })
    expect(again.statusCode).toBe(200)
    expect(await prisma.mcpGrant.count({ where: { agentId: restricted } })).toBe(1)
    expect(lastAssign(frames).toolPolicies).toEqual([{ allow: ['create', 'search'], approval: [], ask: [] }])

    const list = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${restricted}/mcp-tool-policies` })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toMatchObject({
      policies: [{ providerId: provider.id, allowTools: ['create', 'search'] }],
      compatibility: {
        daemonsWithoutAgentDefinitions: [],
        relaysWithoutToolPolicies: 0,
        daemonsWithoutApprovals: [CAPABLE],
        relaysWithoutApprovals: 1
      }
    })
  })

  it('an approval-capable daemon gets a daemon grant with the approval-gated names, an older one a runtime grant with them Blocked', async () => {
    const { app, control, frames } = makeApp({ relayFeatures: ['mcp-tool-policy-v1', 'mcp-tool-approval-v1'] })
    const provider = await seedWorld(app)
    await seedDaemon(prisma, APPROVER)
    await seedDaemon(prisma, CAPABLE)
    const onApprover = await placedAgent(APPROVER, ['docs'])
    const onCapable = await placedAgent(CAPABLE, ['docs'])
    await app.deps.repos.mcpToolCatalog.put(OrgId(DEFAULT_ORG_ID), provider.id, {
      tools: [
        { name: 'search', readOnlyHint: true, interactive: false },
        { name: 'create', readOnlyHint: false, interactive: false },
        { name: 'misc', interactive: false }
      ],
      fetchedAt: new Date('2026-11-20T00:00:00Z'),
      failure: null
    })
    const gated = { groups: { readOnly: 'allow', write: 'approval', other: 'block' }, overrides: {} }
    const grantsOf = (agentId: string) =>
      app.deps.repos.mcpGrant.activeForAgent(OrgId(DEFAULT_ORG_ID), provider.id, agentId)
    const ownDef = (agentId: string) => control.upserts.filter((u) => u.spec.agentId === agentId).at(-1)!

    expect(
      (await app.app.inject({ method: 'PUT', url: policyUrl(onApprover, provider.id), payload: gated })).statusCode
    ).toBe(200)
    const [daemonGrant, ...noRuntime] = await grantsOf(onApprover)
    expect(daemonGrant).toMatchObject({ custody: 'daemon' })
    expect(noRuntime).toEqual([])
    expect(ownDef(onApprover)).toMatchObject({
      daemonId: APPROVER,
      spec: {
        headers: [{ name: 'Authorization', value: `Bearer ${daemonGrant!.key}` }],
        toolDecisions: { allow: ['search'], approval: ['create'], ask: [], block: ['misc'] }
      }
    })

    expect(
      (await app.app.inject({ method: 'PUT', url: policyUrl(onCapable, provider.id), payload: gated })).statusCode
    ).toBe(200)
    const [runtimeGrant, ...noDaemon] = await grantsOf(onCapable)
    expect(runtimeGrant).toMatchObject({ custody: 'runtime' })
    expect(noDaemon).toEqual([])
    expect(ownDef(onCapable)).toMatchObject({
      daemonId: CAPABLE,
      spec: {
        headers: [{ name: 'Authorization', value: `Bearer ${runtimeGrant!.key}` }],
        toolDecisions: { allow: ['search'], approval: [], ask: [], block: ['create', 'misc'] }
      }
    })

    // The relay judges each hash by its own custody's table.
    const assign = lastAssign(frames)
    const tableOf = (key: string) =>
      assign.toolPolicies![assign.restrictedGrants!.find((g) => g.grantKeyHash === grantKeyHash(key))!.policy]
    expect(tableOf(daemonGrant!.key)).toEqual({ allow: ['search'], approval: ['create'], ask: [] })
    expect(tableOf(runtimeGrant!.key)).toEqual({ allow: ['search'], approval: [], ask: [] })

    const list = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${onCapable}/mcp-tool-policies` })
    expect(list.json().compatibility).toMatchObject({ daemonsWithoutApprovals: [CAPABLE], relaysWithoutApprovals: 0 })
  })

  it('an older daemon serving a restricted agent drops the provider from its spec and receives no definition for it', async () => {
    const { app, control } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, OLDER)
    const agentId = await placedAgent(OLDER, ['docs'])
    control.upserts.length = 0

    expect(
      (await app.app.inject({ method: 'PUT', url: policyUrl(agentId, provider.id), payload: READ_ONLY })).statusCode
    ).toBe(200)
    expect(control.upserts).toEqual([])
    expect(control.removes).toEqual([{ daemonId: OLDER, name: 'docs' }])
    expect(control.specs.at(-1)).toEqual({ daemonId: OLDER, mcpServers: [] })
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/mcp-tool-policies` })
    expect(list.json().compatibility.daemonsWithoutAgentDefinitions).toEqual([OLDER])
    // The spec carries the revision the policy write produced, or the daemon would refuse it as a conflict.
    const stored = async () => String((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).configRevision)
    expect(control.revisions.at(-1)).toBe(await stored())
    expect((await app.app.inject({ method: 'DELETE', url: policyUrl(agentId, provider.id) })).statusCode).toBe(204)
    expect(control.specs.at(-1)).toEqual({ daemonId: OLDER, mcpServers: ['docs'] })
    expect(control.revisions.at(-1)).toBe(await stored())
  })

  it('a failed first fetch is no snapshot: the table is the overrides alone and drift is null', async () => {
    const { app } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, CAPABLE)
    const agentId = await placedAgent(CAPABLE, ['docs'])
    expect(await app.deps.repos.mcpToolCatalog.get(OrgId(DEFAULT_ORG_ID), provider.id)).toMatchObject({
      tools: [],
      fetchedAt: null,
      failure: 'relay_unavailable'
    })
    const saved = await app.app.inject({
      method: 'PUT',
      url: policyUrl(agentId, provider.id),
      payload: { ...READ_ONLY, overrides: { search: 'allow' } }
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ allowTools: ['search'], catalogFetchedAt: null, drift: null })
  })

  it('DELETE restores the shared definition, removes the agent’s own, then revokes and unassigns its grant', async () => {
    const { app, control, frames } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, CAPABLE)
    const agentId = await placedAgent(CAPABLE, ['docs'])
    await app.app.inject({ method: 'PUT', url: policyUrl(agentId, provider.id), payload: READ_ONLY })
    const [grant] = await app.deps.repos.mcpGrant.activeForAgent(OrgId(DEFAULT_ORG_ID), provider.id, agentId)
    control.events.length = 0

    const removed = await app.app.inject({ method: 'DELETE', url: policyUrl(agentId, provider.id) })
    expect(removed.statusCode).toBe(204)
    expect(control.events).toEqual([
      `upsert:${CAPABLE}:shared`,
      `remove:${CAPABLE}:${agentId}`,
      'relay:rc/mcp-unassign'
    ])
    expect(frames.at(-1)).toEqual({
      type: 'rc/mcp-unassign',
      payload: { providerId: provider.id, grantKeyHash: grantKeyHash(grant!.key) } satisfies RcMcpUnassign
    })
    expect((await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grant!.id } })).status).toBe('revoked')
    expect(await prisma.agentMcpToolPolicy.count()).toBe(0)
    expect((await app.app.inject({ method: 'DELETE', url: policyUrl(agentId, provider.id) })).statusCode).toBe(404)
  })

  it('disabling the provider keeps the policy and grant; re-enabling restores the restriction', async () => {
    const { app, control } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, CAPABLE)
    const agentId = await placedAgent(CAPABLE, ['docs'])
    await app.app.inject({ method: 'PUT', url: policyUrl(agentId, provider.id), payload: READ_ONLY })

    const off = await app.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { mcpServers: [] } })
    expect(off.statusCode).toBe(200)
    expect(control.removes).toContainEqual({ daemonId: CAPABLE, name: 'docs', agentId })
    expect(await prisma.agentMcpToolPolicy.count({ where: { agentId } })).toBe(1)
    expect(await prisma.mcpGrant.count({ where: { agentId, status: 'active' } })).toBe(1)

    control.upserts.length = 0
    const on = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['docs'] }
    })
    expect(on.statusCode).toBe(200)
    expect(control.upserts.map((u) => u.spec.agentId)).toEqual([agentId])
  })

  it('deleting a provider no agent enables cascades the policies and grants it still holds', async () => {
    const { app, frames } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, CAPABLE)
    const agentId = await placedAgent(CAPABLE, ['docs'])
    await app.app.inject({ method: 'PUT', url: policyUrl(agentId, provider.id), payload: READ_ONLY })
    await app.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { mcpServers: [] } })

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${provider.id}` })).statusCode).toBe(
      204
    )
    expect(await prisma.agentMcpToolPolicy.count()).toBe(0)
    expect(await prisma.mcpGrant.count({ where: { agentId } })).toBe(0)
    expect(frames.at(-1)).toEqual({ type: 'rc/mcp-unassign', payload: { providerId: provider.id } })
  })

  it('deleting the agent cascades its policy and grants and unassigns their hashes', async () => {
    const { app, frames } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, CAPABLE)
    const agentId = await placedAgent(CAPABLE, ['docs'])
    await app.app.inject({ method: 'PUT', url: policyUrl(agentId, provider.id), payload: READ_ONLY })
    const [grant] = await app.deps.repos.mcpGrant.activeForAgent(OrgId(DEFAULT_ORG_ID), provider.id, agentId)

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })).statusCode).toBe(204)
    expect(await prisma.agentMcpToolPolicy.count()).toBe(0)
    expect(await prisma.mcpGrant.count({ where: { agentId } })).toBe(0)
    expect(frames).toContainEqual({
      type: 'rc/mcp-unassign',
      payload: { providerId: provider.id, grantKeyHash: grantKeyHash(grant!.key) }
    })
  })

  it('a rotation keeps the restricted grant in the binding', async () => {
    const { app, frames } = makeApp()
    const provider = await seedWorld(app)
    await seedDaemon(prisma, CAPABLE)
    const agentId = await placedAgent(CAPABLE, ['docs'])
    await app.app.inject({ method: 'PUT', url: policyUrl(agentId, provider.id), payload: READ_ONLY })
    const [grant] = await app.deps.repos.mcpGrant.activeForAgent(OrgId(DEFAULT_ORG_ID), provider.id, agentId)

    const rotated = await app.app.inject({ method: 'POST', url: `${ORG}/mcp-providers/${provider.id}/grant/rotate` })
    expect(rotated.statusCode).toBe(200)
    const assign = lastAssign(frames)
    expect(assign.grantKeyHashes).toEqual([grantKeyHash(rotated.json().grantKey)])
    expect(assign.restrictedGrants).toEqual([{ grantKeyHash: grantKeyHash(grant!.key), policy: 0 }])
    expect(frames.filter((f) => f.type === 'rc/mcp-unassign').map((f) => f.payload)).toEqual([
      { providerId: provider.id, grantKeyHash: grantKeyHash(provider.grantKey) }
    ])
  })
})
