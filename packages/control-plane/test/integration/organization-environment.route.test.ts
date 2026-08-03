/**
 * The organization environment registry, end to end
 * (docs/designs/organization-secrets-and-variables.md §10 verification list).
 *
 * Covers: owner-only registry access; ordinary agent-view access to assigned rows;
 * no restricted-agent discovery or first-time mutation through lists, `all`
 * enrollment, or point binding requests; rotation through an already-authorized
 * durable binding; materialized `all`, empty `selected`, add/remove, new-agent
 * enrollment, agent deletion, and audience transitions; the three permitted
 * variable/secret collisions and the rejection of the forbidden downgrade from BOTH
 * write directions; fallback restoration after unassignment; write-only secret DTOs
 * and cipher round-trip; batch agent DTO resolution without decryption; full-map
 * replication and monotonic `configRevision`; missing-secret suppression; and the
 * daemon feature gate.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentUpsert } from '@agentconnect.md/protocol'
import { AGENT_CONFIG_REVISION_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { NoConnection, type ControlSender } from '../../src/orchestrator/outbound.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const ENV = `${ORG}/environment`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const LEGACY_DAEMON = 'e0e0e0e0-eeee-4eee-8eee-eeeeeeeeeeee'

const CAPABLE = {
  platforms: ['slack'],
  runtimes: ['claude'],
  acp: true,
  features: ['agent-move-v1', AGENT_CONFIG_REVISION_FEATURE]
}
// A daemon that is otherwise current — it can even accept moves — but predates the
// configRevision fence. It must be refused as a placement target for a BOUND agent.
const LEGACY = { platforms: ['slack'], runtimes: ['claude'], acp: true, features: ['agent-move-v1'] }

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** Records every replicated spec so tests can assert the FULL resolved maps. */
class RecordingControl {
  readonly upserts: Array<{ daemonId: string; request: AgentUpsert }> = []
  fail = false

  async agentUpsert(daemonId: string, request: AgentUpsert): Promise<{ ok: true }> {
    if (this.fail) throw new NoConnection(daemonId)
    this.upserts.push({ daemonId, request })
    return { ok: true }
  }

  /** The most recent spec replicated for one agent. */
  last(agentId: string): AgentUpsert['spec'] | undefined {
    return [...this.upserts].reverse().find((u) => u.request.agentId === agentId)?.request.spec
  }
}

function app(options: { userId?: string; control?: RecordingControl } = {}): HttpApp {
  const liveness: DaemonLiveness = {
    get: (daemonId) =>
      daemonId === DAEMON || daemonId === LEGACY_DAEMON
        ? { state: 'READY', reachable: true, sessionEpoch: 1 }
        : undefined
  }
  const built = buildHttpApp(
    prisma,
    options.userId ? { DEFAULT_OWNER_ID: options.userId } : undefined,
    liveness,
    options.control as unknown as ControlSender | undefined
  )
  opened.push(built)
  return built
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@environment.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

interface EntryDto {
  id: string
  key: string
  kind: 'variable' | 'secret'
  variableValue?: string
  secretConfigured?: boolean
  audience: 'all' | 'selected'
  visibleAgentIds: string[]
  version: number
}

async function createEntry(
  http: HttpApp,
  body: Record<string, unknown>
): Promise<{ status: number; entry: EntryDto; raw: string }> {
  const res = await http.app.inject({ method: 'POST', url: ENV, payload: body })
  return {
    status: res.statusCode,
    entry: res.statusCode === 201 ? (res.json() as EntryDto) : ({} as EntryDto),
    raw: res.body
  }
}

function agentEnvOf(spec: AgentUpsert['spec']): Record<string, string> {
  return spec.env ?? {}
}
function agentSecretsOf(spec: AgentUpsert['spec']): Record<string, string> {
  return spec.secrets ?? {}
}

describe('organization environment — authorization and visibility', () => {
  it('is owner-only for list and create', async () => {
    const collaboratorId = await makeUser(`collab-${randomUUID()}`, 'collaborator')
    const asCollaborator = app({ userId: collaboratorId })

    expect((await asCollaborator.app.inject({ method: 'GET', url: ENV })).statusCode).toBe(403)
    const created = await createEntry(asCollaborator, {
      key: 'REGION',
      kind: 'variable',
      value: 'eu',
      audience: 'selected'
    })
    expect(created.status).toBe(403)

    // The owner (the default principal) can.
    const asOwner = app()
    expect((await asOwner.app.inject({ method: 'GET', url: ENV })).statusCode).toBe(200)
  })

  it('never creates the first binding to another member’s restricted agent, via `all` or a point request', async () => {
    const ownerId = await makeUser(`owner-${randomUUID()}`, 'owner')
    const otherId = await makeUser(`other-${randomUUID()}`, 'collaborator')
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const privateAgent = randomUUID()
    // Restricted, owned by someone else and not shared: invisible AND non-editable
    // to the organization owner below.
    await seedAgent(prisma, privateAgent, {
      daemonId: DAEMON,
      visibility: 'restricted',
      ownerUserId: otherId,
      createdByUserId: otherId
    })

    const http = app({ userId: ownerId })
    // `all` enrollment must not reach it.
    const all = await createEntry(http, { key: 'SHARED_VAR', kind: 'variable', value: 'x', audience: 'all' })
    expect(all.status).toBe(201)
    expect(all.entry.visibleAgentIds).not.toContain(privateAgent)
    expect(
      await prisma.organizationEnvironmentAssignment.count({ where: { entryId: all.entry.id, agentId: privateAgent } })
    ).toBe(0)

    // A point request is indistinguishable from a missing agent.
    const selected = await createEntry(http, { key: 'PT', kind: 'variable', value: 'x', audience: 'selected' })
    const bind = await http.app.inject({
      method: 'PUT',
      url: `${ENV}/${selected.entry.id}/agents/${privateAgent}`
    })
    expect(bind.statusCode).toBe(404)
    // …and the same as a truly absent agent id, so nothing can be probed.
    const absent = await http.app.inject({ method: 'PUT', url: `${ENV}/${selected.entry.id}/agents/${randomUUID()}` })
    expect(absent.statusCode).toBe(404)

    // A create naming it up-front is refused outright, and nothing is persisted.
    const upfront = await createEntry(http, {
      key: 'UPFRONT',
      kind: 'variable',
      value: 'x',
      audience: 'selected',
      agentIds: [privateAgent]
    })
    expect(upfront.status).toBe(404)
    expect(await prisma.organizationEnvironmentEntry.count({ where: { key: 'UPFRONT' } })).toBe(0)
  })

  it('rotates through an already-authorized durable binding without granting agent visibility', async () => {
    const ownerId = await makeUser(`owner-${randomUUID()}`, 'owner')
    const otherId = await makeUser(`other-${randomUUID()}`, 'collaborator')
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const privateAgent = randomUUID()
    await seedAgent(prisma, privateAgent, {
      daemonId: DAEMON,
      visibility: 'restricted',
      ownerUserId: otherId,
      createdByUserId: otherId
    })

    const asOwner = app({ userId: ownerId })
    const entry = (await createEntry(asOwner, { key: 'ROT', kind: 'secret', value: 'v1', audience: 'selected' })).entry
    // The AGENT's editor creates the delegation.
    const asOther = app({ userId: otherId })
    expect(
      (await asOther.app.inject({ method: 'PUT', url: `${ENV}/${entry.id}/agents/${privateAgent}` })).statusCode
    ).toBe(
      // Non-owners cannot use the registry endpoints at all, so the binding is
      // created through the repository seam the design describes: an authorized
      // agent editor enrolling the agent. Here that is `all` enrollment, verified
      // separately; a collaborator is correctly refused this owner-only route.
      403
    )

    // Establish the delegation directly (as the authorized agent editor would),
    // then prove the OWNER can rotate without ever seeing the agent.
    await prisma.organizationEnvironmentAssignment.create({
      data: { orgId: DEFAULT_ORG_ID, entryId: entry.id, agentId: privateAgent, authorizedByUserId: otherId }
    })
    const rotate = await asOwner.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, value: 'v2' }
    })
    expect(rotate.statusCode).toBe(200)
    // The response does NOT disclose the private agent it reaches.
    expect((rotate.json() as EntryDto).visibleAgentIds).toEqual([])
    // Nor does the owner's own listing.
    const list = (await asOwner.app.inject({ method: 'GET', url: ENV })).json() as EntryDto[]
    expect(list.find((e) => e.id === entry.id)?.visibleAgentIds).toEqual([])
  })

  it('does not remove an invisible binding when the visible selection is edited', async () => {
    const ownerId = await makeUser(`owner-${randomUUID()}`, 'owner')
    const otherId = await makeUser(`other-${randomUUID()}`, 'collaborator')
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const visible = randomUUID()
    const hidden = randomUUID()
    await seedAgent(prisma, visible, { daemonId: DAEMON, name: 'visible-bot' })
    await seedAgent(prisma, hidden, {
      daemonId: DAEMON,
      name: 'hidden-bot',
      visibility: 'restricted',
      ownerUserId: otherId,
      createdByUserId: otherId
    })

    const http = app({ userId: ownerId })
    const entry = (await createEntry(http, { key: 'KEEP', kind: 'variable', value: 'x', audience: 'selected' })).entry
    await prisma.organizationEnvironmentAssignment.create({
      data: { orgId: DEFAULT_ORG_ID, entryId: entry.id, agentId: hidden, authorizedByUserId: otherId }
    })
    // Add then remove the visible agent — a full round-trip of "editing the selection".
    await http.app.inject({ method: 'PUT', url: `${ENV}/${entry.id}/agents/${visible}` })
    const removed = await http.app.inject({ method: 'DELETE', url: `${ENV}/${entry.id}/agents/${visible}` })
    expect(removed.statusCode).toBe(200)
    // The invisible delegated binding survives untouched.
    expect(await prisma.organizationEnvironmentAssignment.count({ where: { entryId: entry.id } })).toBe(1)
    expect(
      await prisma.organizationEnvironmentAssignment.count({ where: { entryId: entry.id, agentId: hidden } })
    ).toBe(1)
  })
})

describe('organization environment — audience and enrollment', () => {
  it('materializes `all` over every editable agent and enrolls agents created later', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const existing = randomUUID()
    await seedAgent(prisma, existing, { daemonId: DAEMON, name: 'existing-bot' })

    const http = app({ control: new RecordingControl() })
    const entry = (await createEntry(http, { key: 'ALL_VAR', kind: 'variable', value: 'v', audience: 'all' })).entry
    expect(entry.visibleAgentIds).toContain(existing)

    // A NEW agent enrolls in the same transaction as its create.
    const created = await http.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'fresh-bot', runtime: 'claude', capabilities: [] }
    })
    expect(created.statusCode).toBe(201)
    const freshId = (created.json() as { id: string }).id
    expect(
      await prisma.organizationEnvironmentAssignment.count({ where: { entryId: entry.id, agentId: freshId } })
    ).toBe(1)
    // …and the DTO shows the inherited row immediately.
    const dto = (await http.app.inject({ method: 'GET', url: `${ORG}/agents/${freshId}` })).json() as {
      organizationVariables: Array<{ key: string; value: string }>
    }
    expect(dto.organizationVariables).toEqual([{ key: 'ALL_VAR', value: 'v' }])
  })

  it('enrolls an agent that predates the entry on its next configuration write', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const older = randomUUID()
    await seedAgent(prisma, older, { daemonId: DAEMON, name: 'older-bot' })
    const http = app({ control: new RecordingControl() })

    // Unbind the automatic enrollment to simulate an agent that missed it.
    const entry = (await createEntry(http, { key: 'LATE', kind: 'variable', value: 'v', audience: 'all' })).entry
    await prisma.organizationEnvironmentAssignment.deleteMany({ where: { entryId: entry.id, agentId: older } })

    const patched = await http.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${older}`,
      payload: { description: 'touched' }
    })
    expect(patched.statusCode).toBe(200)
    expect(await prisma.organizationEnvironmentAssignment.count({ where: { entryId: entry.id, agentId: older } })).toBe(
      1
    )
  })

  it('accepts an empty `selected` entry an owner is staging', async () => {
    const http = app()
    const entry = (await createEntry(http, { key: 'STAGED', kind: 'secret', value: 's', audience: 'selected' })).entry
    expect(entry.visibleAgentIds).toEqual([])
    expect(entry.secretConfigured).toBe(true)
  })

  it('switching `selected`→`all` adds bindings; `all`→`selected` keeps them but stops auto-enrollment', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const one = randomUUID()
    await seedAgent(prisma, one, { daemonId: DAEMON, name: 'one-bot' })
    const http = app({ control: new RecordingControl() })

    const entry = (await createEntry(http, { key: 'SWITCH', kind: 'variable', value: 'v', audience: 'selected' })).entry
    expect(entry.visibleAgentIds).toEqual([])

    const toAll = await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, audience: 'all' }
    })
    expect(toAll.statusCode).toBe(200)
    expect((toAll.json() as EntryDto).visibleAgentIds).toContain(one)

    const backToSelected = await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: (toAll.json() as EntryDto).version, audience: 'selected' }
    })
    expect(backToSelected.statusCode).toBe(200)
    // Existing bindings are retained — narrowing the audience is not a revocation.
    expect((backToSelected.json() as EntryDto).visibleAgentIds).toContain(one)

    // But a NEW agent no longer auto-enrolls.
    const created = await http.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'after-switch-bot', runtime: 'claude', capabilities: [] }
    })
    const afterId = (created.json() as { id: string }).id
    expect(
      await prisma.organizationEnvironmentAssignment.count({ where: { entryId: entry.id, agentId: afterId } })
    ).toBe(0)
  })

  it('cascades bindings when the agent is deleted', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const doomed = randomUUID()
    await seedAgent(prisma, doomed, { name: 'doomed-bot' })
    const http = app({ control: new RecordingControl() })
    const entry = (await createEntry(http, { key: 'CASCADE', kind: 'variable', value: 'v', audience: 'all' })).entry
    expect(entry.visibleAgentIds).toContain(doomed)

    expect((await http.app.inject({ method: 'DELETE', url: `${ORG}/agents/${doomed}` })).statusCode).toBe(204)
    expect(await prisma.organizationEnvironmentAssignment.count({ where: { agentId: doomed } })).toBe(0)
    // The entry itself survives its last binding being removed.
    expect(await prisma.organizationEnvironmentEntry.count({ where: { id: entry.id } })).toBe(1)
  })

  it('rejects a duplicate key across BOTH kinds — one organization keyspace', async () => {
    const http = app()
    expect((await createEntry(http, { key: 'DUP', kind: 'variable', value: 'v', audience: 'selected' })).status).toBe(
      201
    )
    // Same name, other kind: still a conflict.
    const dup = await createEntry(http, { key: 'DUP', kind: 'secret', value: 's', audience: 'selected' })
    expect(dup.status).toBe(409)
  })

  it('fences a competing editor with 409 rather than losing a rotation', async () => {
    const http = app()
    const entry = (await createEntry(http, { key: 'FENCE', kind: 'secret', value: 'v1', audience: 'selected' })).entry
    const first = await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, value: 'v2' }
    })
    expect(first.statusCode).toBe(200)
    // The second editor still holds the stale version.
    const second = await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, value: 'v3' }
    })
    expect(second.statusCode).toBe(409)
  })

  it('refuses `key`/`kind` changes structurally — rename is delete-and-create', async () => {
    const http = app()
    const entry = (await createEntry(http, { key: 'IMMUT', kind: 'variable', value: 'v', audience: 'selected' })).entry
    const res = await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, key: 'RENAMED', kind: 'secret' }
    })
    // Whether the schema strips or rejects them, the stored row must not change.
    const row = await prisma.organizationEnvironmentEntry.findUniqueOrThrow({ where: { id: entry.id } })
    expect(row.key).toBe('IMMUT')
    expect(row.kind).toBe('variable')
    expect([200, 400]).toContain(res.statusCode)
  })
})

describe('organization environment — write-only secrets', () => {
  it('never echoes a secret value in any response, and stores it through the cipher', async () => {
    const http = app()
    const secretValue = 'super-secret-value-4f2b'
    const created = await createEntry(http, {
      key: 'TOKEN',
      kind: 'secret',
      value: secretValue,
      audience: 'selected'
    })
    expect(created.status).toBe(201)
    expect(created.raw).not.toContain(secretValue)
    expect(created.entry.secretConfigured).toBe(true)
    expect(created.entry).not.toHaveProperty('variableValue')

    const list = await http.app.inject({ method: 'GET', url: ENV })
    expect(list.body).not.toContain(secretValue)

    // The value IS stored, behind the store seam (identity cipher under test config).
    const row = await prisma.organizationEnvironmentSecret.findUniqueOrThrow({ where: { entryId: created.entry.id } })
    expect(row.value).toBe(secretValue)
  })

  it('keeps the stored secret when PATCH omits the value', async () => {
    const http = app()
    const entry = (await createEntry(http, { key: 'KEEPME', kind: 'secret', value: 'original', audience: 'selected' }))
      .entry
    const res = await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, audience: 'all' }
    })
    expect(res.statusCode).toBe(200)
    const row = await prisma.organizationEnvironmentSecret.findUniqueOrThrow({ where: { entryId: entry.id } })
    expect(row.value).toBe('original')
  })

  it('exposes only KEY NAMES for an assigned organization secret on the agent DTO', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'dto-bot' })
    const http = app({ control: new RecordingControl() })
    await createEntry(http, { key: 'ORG_SECRET', kind: 'secret', value: 'never-leaves', audience: 'all' })

    const res = await http.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })
    expect(res.body).not.toContain('never-leaves')
    const dto = res.json() as { organizationSecretKeys: string[]; organizationVariables: unknown[] }
    expect(dto.organizationSecretKeys).toEqual(['ORG_SECRET'])
    expect(dto.organizationVariables).toEqual([])
  })

  it('resolves the agent LIST without decrypting any organization secret', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const a = randomUUID()
    const b = randomUUID()
    await seedAgent(prisma, a, { daemonId: DAEMON, name: 'list-a' })
    await seedAgent(prisma, b, { daemonId: DAEMON, name: 'list-b' })
    const http = app({ control: new RecordingControl() })
    await createEntry(http, { key: 'BATCH_SECRET', kind: 'secret', value: 'batch-plaintext', audience: 'all' })
    await createEntry(http, { key: 'BATCH_VAR', kind: 'variable', value: 'batch-visible', audience: 'all' })

    const res = await http.app.inject({ method: 'GET', url: `${ORG}/agents` })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('batch-plaintext')
    const rows = res.json() as Array<{ id: string; organizationSecretKeys: string[]; organizationVariables: unknown[] }>
    for (const id of [a, b]) {
      const row = rows.find((r) => r.id === id)!
      expect(row.organizationSecretKeys).toEqual(['BATCH_SECRET'])
      expect(row.organizationVariables).toEqual([{ key: 'BATCH_VAR', value: 'batch-visible' }])
    }
  })
})

describe('organization environment — precedence in the replicated spec', () => {
  it('an organization variable overrides an agent variable, and unassigning restores it', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'prec-bot' })
    await prisma.agent.update({ where: { id: agentId }, data: { runtimeOverrides: { env: { REGION: 'local' } } } })

    const control = new RecordingControl()
    const http = app({ control })
    const entry = (await createEntry(http, { key: 'REGION', kind: 'variable', value: 'us-east-1', audience: 'all' }))
      .entry
    expect(agentEnvOf(control.last(agentId)!)).toEqual({ REGION: 'us-east-1' })

    // Unassign: the retained agent row becomes effective again, with no re-entry.
    const patched = await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, audience: 'selected' }
    })
    expect(patched.statusCode).toBe(200)
    await http.app.inject({ method: 'DELETE', url: `${ENV}/${entry.id}/agents/${agentId}` })
    expect(agentEnvOf(control.last(agentId)!)).toEqual({ REGION: 'local' })
  })

  it('an organization secret overrides an agent secret AND an agent variable', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const secretSide = randomUUID()
    const variableSide = randomUUID()
    await seedAgent(prisma, secretSide, { daemonId: DAEMON, name: 'sec-side' })
    await seedAgent(prisma, variableSide, { daemonId: DAEMON, name: 'var-side' })
    await prisma.agentSecret.create({ data: { agentId: secretSide, key: 'API_KEY', value: 'agent-secret' } })
    await prisma.agent.update({
      where: { id: variableSide },
      data: { runtimeOverrides: { env: { API_KEY: 'agent-plain' } } }
    })

    const control = new RecordingControl()
    const http = app({ control })
    expect(
      (await createEntry(http, { key: 'API_KEY', kind: 'secret', value: 'org-secret', audience: 'all' })).status
    ).toBe(201)

    // Same-kind override.
    expect(agentSecretsOf(control.last(secretSide)!)).toEqual({ API_KEY: 'org-secret' })
    // Upgrade: the key moves OUT of env into the write-only map.
    expect(agentSecretsOf(control.last(variableSide)!)).toEqual({ API_KEY: 'org-secret' })
    expect(agentEnvOf(control.last(variableSide)!)).toEqual({})
  })

  it('refuses an organization VARIABLE that would declassify an agent secret', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'downgrade-bot' })
    await prisma.agentSecret.create({ data: { agentId, key: 'API_KEY', value: 'agent-secret' } })

    const http = app({ control: new RecordingControl() })
    const res = await createEntry(http, { key: 'API_KEY', kind: 'variable', value: 'plain', audience: 'all' })
    expect(res.status).toBe(409)
    // Names may appear (they are names), values may not.
    expect(res.raw).toContain('API_KEY')
    expect(res.raw).not.toContain('agent-secret')
    expect(await prisma.organizationEnvironmentEntry.count({ where: { key: 'API_KEY' } })).toBe(0)
  })

  it('refuses the same downgrade from the AGENT-LOCAL direction', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'reverse-bot' })
    const http = app({ control: new RecordingControl() })
    // The organization variable exists and is assigned FIRST.
    expect(
      (await createEntry(http, { key: 'SHARED_KEY', kind: 'variable', value: 'plain', audience: 'all' })).status
    ).toBe(201)

    // Now the agent editor tries to add a same-name SECRET underneath it.
    const res = await http.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { secrets: { SHARED_KEY: 'agent-secret' } }
    })
    expect(res.statusCode).toBe(409)
    // Nothing was persisted — the whole transaction rolled back.
    expect(await prisma.agentSecret.count({ where: { agentId, key: 'SHARED_KEY' } })).toBe(0)
  })

  it('tombstones an organization secret with no stored material instead of falling back', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'tombstone-bot' })
    await prisma.agentSecret.create({ data: { agentId, key: 'API_KEY', value: 'stale-agent-secret' } })

    const control = new RecordingControl()
    const http = app({ control })
    const entry = (await createEntry(http, { key: 'API_KEY', kind: 'secret', value: 'org-value', audience: 'all' }))
      .entry
    expect(agentSecretsOf(control.last(agentId)!)).toEqual({ API_KEY: 'org-value' })

    // Simulate the invalid-entry state §9 describes: metadata without material.
    await prisma.organizationEnvironmentSecret.delete({ where: { entryId: entry.id } })
    // Force a fresh assembly by touching the agent.
    await http.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { description: 'touch' } })
    const spec = control.last(agentId)!
    // The key is absent from BOTH maps — it must NOT reactivate the agent secret.
    expect(agentSecretsOf(spec)).toEqual({})
    expect(agentEnvOf(spec)).toEqual({})
  })
})

describe('organization environment — replication and revisions', () => {
  it('ships a monotonic configRevision on every replicated spec', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'rev-bot' })
    const control = new RecordingControl()
    const http = app({ control })

    const entry = (await createEntry(http, { key: 'REV', kind: 'variable', value: 'v1', audience: 'all' })).entry
    const first = control.last(agentId)!.configRevision
    expect(first).toMatch(/^(0|[1-9][0-9]*)$/)

    await http.app.inject({
      method: 'PATCH',
      url: `${ENV}/${entry.id}`,
      payload: { expectedVersion: entry.version, value: 'v2' }
    })
    const second = control.last(agentId)!.configRevision
    expect(BigInt(second!)).toBeGreaterThan(BigInt(first!))

    // An ordinary agent edit shares the SAME ordering domain, not a separate one.
    await http.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { description: 'edited' } })
    expect(BigInt(control.last(agentId)!.configRevision!)).toBeGreaterThan(BigInt(second!))
  })

  it('replicates a FULL map so a deleted entry clears its key from the daemon', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'full-map-bot' })
    const control = new RecordingControl()
    const http = app({ control })

    const entry = (await createEntry(http, { key: 'GOING_AWAY', kind: 'variable', value: 'v', audience: 'all' })).entry
    expect(agentEnvOf(control.last(agentId)!)).toEqual({ GOING_AWAY: 'v' })

    expect((await http.app.inject({ method: 'DELETE', url: `${ENV}/${entry.id}` })).statusCode).toBe(204)
    // The whole map is re-sent WITHOUT the key — no separate remove frame.
    expect(agentEnvOf(control.last(agentId)!)).toEqual({})
  })

  it('does not fail the durable write when live fan-out fails', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'offline-bot' })
    const control = new RecordingControl()
    control.fail = true
    const http = app({ control })

    const created = await createEntry(http, { key: 'OFFLINE', kind: 'variable', value: 'v', audience: 'all' })
    expect(created.status).toBe(201)
    // The entry is authoritative; the reconnect roster repairs the daemon.
    expect(await prisma.organizationEnvironmentEntry.count({ where: { id: created.entry.id } })).toBe(1)
  })

  it('needs no event for an unplaced agent', async () => {
    const unplaced = randomUUID()
    await seedAgent(prisma, unplaced, { name: 'unplaced-bot' })
    const control = new RecordingControl()
    const http = app({ control })
    const created = await createEntry(http, { key: 'UNPLACED', kind: 'variable', value: 'v', audience: 'all' })
    expect(created.status).toBe(201)
    expect(control.upserts.filter((u) => u.request.agentId === unplaced)).toEqual([])
  })
})

describe('organization environment — daemon feature gate', () => {
  it('refuses a write that would reach an agent on a daemon without the revision fence', async () => {
    await seedDaemon(prisma, LEGACY_DAEMON, { capabilities: LEGACY })
    const legacyAgent = randomUUID()
    await seedAgent(prisma, legacyAgent, { daemonId: LEGACY_DAEMON, name: 'legacy-bot' })
    const http = app({ control: new RecordingControl() })

    const entry = (await createEntry(http, { key: 'GATED', kind: 'variable', value: 'v', audience: 'selected' })).entry
    const bind = await http.app.inject({ method: 'PUT', url: `${ENV}/${entry.id}/agents/${legacyAgent}` })
    expect(bind.statusCode).toBe(409)
    expect(bind.body).toContain('does not yet support')
    expect(await prisma.organizationEnvironmentAssignment.count({ where: { entryId: entry.id } })).toBe(0)
  })

  it('still allows WITHDRAWING a credential from an agent on an older daemon', async () => {
    await seedDaemon(prisma, LEGACY_DAEMON, { capabilities: LEGACY })
    const legacyAgent = randomUUID()
    await seedAgent(prisma, legacyAgent, { daemonId: LEGACY_DAEMON, name: 'legacy-withdraw-bot' })
    const http = app({ control: new RecordingControl() })
    const entry = (await createEntry(http, { key: 'WITHDRAW', kind: 'secret', value: 'v', audience: 'selected' })).entry
    // A binding that already exists (e.g. created before the daemon downgraded).
    await prisma.organizationEnvironmentAssignment.create({
      data: { orgId: DEFAULT_ORG_ID, entryId: entry.id, agentId: legacyAgent }
    })

    expect(
      (await http.app.inject({ method: 'DELETE', url: `${ENV}/${entry.id}/agents/${legacyAgent}` })).statusCode
    ).toBe(200)
    expect((await http.app.inject({ method: 'DELETE', url: `${ENV}/${entry.id}` })).statusCode).toBe(204)
  })

  it('refuses to PLACE a bound agent on a daemon without the revision fence', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABLE })
    await seedDaemon(prisma, LEGACY_DAEMON, { capabilities: LEGACY })
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON, name: 'move-bot' })
    const http = app({ control: new RecordingControl() })
    expect((await createEntry(http, { key: 'MOVE_GATE', kind: 'variable', value: 'v', audience: 'all' })).status).toBe(
      201
    )

    const moved = await http.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { daemonId: LEGACY_DAEMON }
    })
    expect(moved.statusCode).toBe(409)
    expect(moved.body).toContain('organization variables and secrets')
  })
})
