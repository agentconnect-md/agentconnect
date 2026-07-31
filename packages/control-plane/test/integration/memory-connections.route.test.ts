/**
 * M-5A external-memory REST control plane.
 *
 * Exercises the installation trust action, write-only connection secrets,
 * purpose-specific relay grants, daemon-registry-before-agent ordering, binding
 * validation, rotation, and revocation through the real Fastify + Postgres graph.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  AgentUpsert,
  MemoryConnectionSpec,
  RcMemoryConnectionAssign,
  RcMemoryConnectionUnassign
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { seedDaemon } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayControlSender } from '../../src/orchestrator/relayControl.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const INSTALLATIONS = `${ORG}/memory-plugin-installations`
const CONNECTIONS = `${ORG}/external-memory-connections`
const DAEMON = 'd5555555-5555-4555-8555-555555555555'

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

class SpyControl {
  failMemoryUpsert = false
  readonly events: Array<
    | { kind: 'memory-upsert'; daemonId: string; spec: MemoryConnectionSpec }
    | { kind: 'memory-remove'; daemonId: string; connectionId: string }
    | { kind: 'agent-upsert'; daemonId: string; agent: AgentUpsert }
    | { kind: 'agent-remove'; daemonId: string; agentId: string }
  > = []

  async memoryConnectionUpsert(daemonId: string, spec: MemoryConnectionSpec): Promise<void> {
    this.events.push({ kind: 'memory-upsert', daemonId, spec })
    if (this.failMemoryUpsert) throw new Error('simulated probe rejection')
  }

  async memoryConnectionRemove(daemonId: string, connectionId: string): Promise<void> {
    this.events.push({ kind: 'memory-remove', daemonId, connectionId })
  }

  async agentUpsert(daemonId: string, agent: AgentUpsert): Promise<void> {
    this.events.push({ kind: 'agent-upsert', daemonId, agent })
  }

  async agentRemove(daemonId: string, agentId: string): Promise<void> {
    this.events.push({ kind: 'agent-remove', daemonId, agentId })
  }

  // Creating a PLACED agent also publishes the collaboration snapshot (the flat peer
  // directory). Deliberately NOT recorded in `events`: this suite asserts the exact
  // memory/AgentSpec push ORDER, and the real ControlSender must simply not be missing
  // a method here — an absent one would surface as a swallowed TypeError, not a failure.
  async collaborationRoutes(): Promise<void> {}
}

class SpyRelayControl {
  readonly assigns: RcMemoryConnectionAssign[] = []
  readonly unassigns: RcMemoryConnectionUnassign[] = []

  memoryConnectionAssign(assign: RcMemoryConnectionAssign): void {
    this.assigns.push(assign)
  }

  memoryConnectionUnassign(unassign: RcMemoryConnectionUnassign): void {
    this.unassigns.push(unassign)
  }
}

function build(spies?: { control?: SpyControl; relay?: SpyRelayControl }, ownerId?: string): HttpApp {
  const app = buildHttpApp(
    prisma,
    { RELAY_STALE_MS: 60_000, ...(ownerId ? { DEFAULT_OWNER_ID: ownerId } : {}) },
    undefined,
    spies?.control as unknown as ControlSender,
    spies?.relay ? { relayControl: spies.relay as unknown as RelayControlSender } : undefined
  )
  opened.push(app)
  return app
}

const installationPayload = (overrides: Record<string, unknown> = {}) => ({
  pluginId: 'ai.example.memory',
  transport: 'streamable-http',
  endpoint: 'https://plugin.example/mcp',
  expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
  secretHeaders: [{ name: 'apiKey', header: 'Authorization', required: true }],
  ...overrides
})

async function createInstallation(app: HttpApp): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: INSTALLATIONS, payload: installationPayload() })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

async function createConnection(app: HttpApp, installationId: string): Promise<{ id: string; revision: number }> {
  const res = await app.app.inject({
    method: 'POST',
    url: CONNECTIONS,
    payload: { installationId, config: { projectId: 'p1' }, secrets: { apiKey: 'upstream-secret' } }
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { id: string; revision: number }
}

async function addLiveRelay(app: HttpApp): Promise<void> {
  await app.deps.repos.relay.upsertByName('relay-0', 'wss://relay.example/rd', new Date())
}

describe('memory plugin installations — owner-reviewed trust boundary', () => {
  it('rejects local/private/credentialed endpoints, unsafe command refs, and reserved injected headers', async () => {
    const app = build()
    for (const payload of [
      installationPayload({ endpoint: 'http://127.0.0.1/mcp' }),
      installationPayload({ endpoint: 'https://user:pass@plugin.example/mcp' }),
      installationPayload({ transport: 'stdio', endpoint: undefined, commandRef: '../../tenant-command' }),
      installationPayload({ transport: 'stdio', endpoint: undefined, commandRef: '/usr/bin/mem0' }),
      installationPayload({ secretHeaders: [{ name: 'key', header: 'Host', required: true }] })
    ]) {
      const res = await app.app.inject({ method: 'POST', url: INSTALLATIONS, payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('registers only an operator allowlist reference for stdio, never a command or path', async () => {
    const app = build()
    const accepted = await app.app.inject({
      method: 'POST',
      url: INSTALLATIONS,
      payload: installationPayload({ transport: 'stdio', endpoint: undefined, commandRef: 'operator-mem0' })
    })
    expect(accepted.statusCode, accepted.body).toBe(201)
    expect(accepted.json()).toMatchObject({
      transport: 'stdio',
      endpoint: null,
      commandRef: 'operator-mem0'
    })
    const rawCommand = await app.app.inject({
      method: 'POST',
      url: INSTALLATIONS,
      payload: {
        ...installationPayload({ transport: 'stdio', endpoint: undefined, commandRef: 'operator-mem0' }),
        command: '/usr/bin/mem0',
        args: ['--stdio']
      }
    })
    expect(rawCommand.statusCode).toBe(400)
  })

  it('is owner-only and allows independently reviewed pins for the same plugin', async () => {
    const users = new PgUserRepo(prisma)
    const email = `memory-${randomUUID()}@acme.dev`
    const { userId } = await users.provisionOidcUser({
      oidcSubject: `memory-${randomUUID()}`,
      email,
      emailVerified: true
    })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
    const collaborator = build(undefined, userId)
    expect(
      (await collaborator.app.inject({ method: 'POST', url: INSTALLATIONS, payload: installationPayload() })).statusCode
    ).toBe(403)

    const owner = build()
    await createInstallation(owner)
    const secondEndpoint = await owner.app.inject({
      method: 'POST',
      url: INSTALLATIONS,
      payload: installationPayload({ endpoint: 'https://regional.plugin.example/mcp' })
    })
    expect(secondEndpoint.statusCode).toBe(201)
    const replacementPin = await owner.app.inject({
      method: 'POST',
      url: INSTALLATIONS,
      payload: installationPayload({ expectedManifestDigest: `sha256:${'b'.repeat(64)}` })
    })
    expect(replacementPin.statusCode).toBe(201)
  })

  it('serializes installation deletion against connection creation', async () => {
    const app = build()
    const installationId = await createInstallation(app)
    const repo = app.deps.repos.externalMemoryConnection
    const create = repo.create.bind(repo)
    let entered!: () => void
    let resume!: () => void
    let pendingConnectionId = ''
    const started = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (resume = resolve))
    repo.create = async (...args) => {
      pendingConnectionId = args[0].id ?? ''
      entered()
      await blocked
      return create(...args)
    }

    const creating = app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: { installationId, config: {}, secrets: { apiKey: 'secret' } }
    })
    await started
    const binding = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'half-created-connection-agent',
        runtime: 'claude',
        memory: { provider: 'external', connectionId: pendingConnectionId }
      }
    })
    expect(binding.statusCode).toBe(409)
    const deleting = await app.app.inject({ method: 'DELETE', url: `${INSTALLATIONS}/${installationId}` })
    expect(deleting.statusCode).toBe(409)
    resume()
    expect((await creating).statusCode).toBe(201)
    expect(await app.deps.repos.memoryPluginInstallation.get(installationId)).not.toBeNull()
  })
})

describe('external-memory connections — secret/grant discipline', () => {
  it('projects stdio through a secret lease without relay/grants and rejects relay rotation', async () => {
    const control = new SpyControl()
    const relay = new SpyRelayControl()
    const app = build({ control, relay })
    await seedDaemon(prisma, DAEMON)
    const installationResponse = await app.app.inject({
      method: 'POST',
      url: INSTALLATIONS,
      payload: installationPayload({ transport: 'stdio', endpoint: undefined, commandRef: 'operator-mem0' })
    })
    expect(installationResponse.statusCode).toBe(201)
    const installationId = (installationResponse.json() as { id: string }).id
    const connectionResponse = await app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: { installationId, config: { projectId: 'local' }, secrets: { apiKey: 'local-upstream-secret' } }
    })
    expect(connectionResponse.statusCode).toBe(201)
    expect(connectionResponse.body).not.toContain('local-upstream-secret')
    const connectionId = (connectionResponse.json() as { id: string }).id
    expect(await app.deps.repos.externalMemoryGrant.activeForConnection(connectionId)).toEqual([])
    expect(relay.assigns).toEqual([])

    const agent = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'local-memory-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        memory: { provider: 'external', connectionId }
      }
    })
    expect(agent.statusCode, agent.body).toBe(201)
    const memoryEvent = control.events.find((event) => event.kind === 'memory-upsert')
    expect(memoryEvent).toMatchObject({
      kind: 'memory-upsert',
      daemonId: DAEMON,
      spec: {
        transport: 'stdio',
        commandRef: 'operator-mem0',
        config: { projectId: 'local' },
        secretKeys: ['apiKey'],
        secretLease: { values: { apiKey: 'local-upstream-secret' } }
      }
    })
    expect(JSON.stringify(memoryEvent)).not.toContain('/usr/bin')

    const rotation = await app.app.inject({ method: 'POST', url: `${CONNECTIONS}/${connectionId}/grant/rotate` })
    expect(rotation.statusCode).toBe(400)
    expect((rotation.json() as { message: string }).message).toContain('no relay grant')
    expect(await app.deps.repos.externalMemoryConnection.get(connectionId)).toMatchObject({ revision: 1 })
    expect(relay.unassigns).toEqual([])

    const unbound = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${(agent.json() as { id: string }).id}`,
      payload: { memory: { provider: 'managed' } }
    })
    expect(unbound.statusCode).toBe(200)
    expect((await app.app.inject({ method: 'DELETE', url: `${CONNECTIONS}/${connectionId}` })).statusCode).toBe(204)
    expect(relay.unassigns).toEqual([])
  })

  it('validates the reviewed secret contract and never returns secret or grant values', async () => {
    const relay = new SpyRelayControl()
    const app = build({ relay })
    const installationId = await createInstallation(app)

    const missing = await app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: { installationId, config: {}, secrets: {} }
    })
    expect(missing.statusCode).toBe(400)
    const unknown = await app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: { installationId, config: {}, secrets: { apiKey: 'ok', extra: 'no' } }
    })
    expect(unknown.statusCode).toBe(400)
    const headerInjection = await app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: { installationId, config: {}, secrets: { apiKey: 'token\r\nX-Injected: yes' } }
    })
    expect(headerInjection.statusCode).toBe(400)
    const wideFields = Array.from({ length: 5 }, (_, index) => ({
      name: `key${index}`,
      header: `X-Key-${index}`,
      required: true
    }))
    const wideInstallation = await app.app.inject({
      method: 'POST',
      url: INSTALLATIONS,
      payload: installationPayload({ pluginId: 'ai.example.wide-memory', secretHeaders: wideFields })
    })
    expect(wideInstallation.statusCode).toBe(201)
    const oversizedSecrets = await app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: {
        installationId: (wideInstallation.json() as { id: string }).id,
        config: {},
        secrets: Object.fromEntries(wideFields.map((field) => [field.name, 'x'.repeat(16 * 1024)]))
      }
    })
    expect(oversizedSecrets.statusCode).toBe(400)
    expect((oversizedSecrets.json() as { message: string }).message).toContain('64 KiB')
    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth < 10; depth += 1) nested = { child: nested }
    const tooDeep = await app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: { installationId, config: nested, secrets: { apiKey: 'ok' } }
    })
    expect(tooDeep.statusCode).toBe(400)

    const created = await app.app.inject({
      method: 'POST',
      url: CONNECTIONS,
      payload: { installationId, config: { projectId: 'p1' }, secrets: { apiKey: 'upstream-secret' } }
    })
    expect(created.statusCode).toBe(201)
    expect(created.body).not.toContain('upstream-secret')
    const dto = created.json() as { id: string; secretKeys: string[]; status: string; revision: number }
    expect(dto).toMatchObject({ secretKeys: ['apiKey'], status: 'probing', revision: 1 })
    expect(await app.deps.repos.externalMemoryConnectionSecret.get(dto.id)).toEqual({ apiKey: 'upstream-secret' })
    const grants = await app.deps.repos.externalMemoryGrant.activeForConnection(dto.id)
    expect(grants).toHaveLength(1)
    expect(created.body).not.toContain(grants[0]!.key)

    // Only the relay-side projection receives upstream location + credential.
    expect(relay.assigns).toHaveLength(1)
    expect(relay.assigns[0]).toMatchObject({
      connectionId: dto.id,
      upstreamUrl: 'https://plugin.example/mcp',
      headers: [{ name: 'Authorization', value: 'upstream-secret' }]
    })
    expect(relay.assigns[0]!.grantKeyHashes).toHaveLength(1)

    const read = await app.app.inject({ method: 'GET', url: `${CONNECTIONS}/${dto.id}` })
    expect(read.statusCode).toBe(200)
    expect(read.body).not.toContain('upstream-secret')
    expect(read.body).not.toContain(grants[0]!.key)
  })

  it('increments revision on config/secret replacement and rotates grants overlap-first', async () => {
    const relay = new SpyRelayControl()
    const app = build({ relay })
    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)
    const firstGrant = (await app.deps.repos.externalMemoryGrant.activeForConnection(connection.id))[0]!

    const updated = await app.app.inject({
      method: 'PATCH',
      url: `${CONNECTIONS}/${connection.id}`,
      payload: { config: { projectId: 'p2' }, secrets: { apiKey: 'rotated-upstream-secret' } }
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.body).not.toContain('rotated-upstream-secret')
    expect(updated.json()).toMatchObject({ revision: 2, status: 'probing', probedRevision: null })

    const rotated = await app.app.inject({
      method: 'POST',
      url: `${CONNECTIONS}/${connection.id}/grant/rotate`
    })
    expect(rotated.statusCode).toBe(200)
    expect(rotated.json()).toMatchObject({ revision: 3, status: 'probing', probedRevision: null })
    const active = await app.deps.repos.externalMemoryGrant.activeForConnection(connection.id)
    expect(active).toHaveLength(1)
    expect(active[0]!.id).not.toBe(firstGrant.id)
    expect(rotated.body).not.toContain(active[0]!.key)

    // Last assign carries old+new hashes before the old hash is retired.
    expect(relay.assigns.at(-1)!.grantKeyHashes).toHaveLength(2)
    expect(relay.unassigns.at(-1)).toMatchObject({ connectionId: connection.id })
    expect(relay.unassigns.at(-1)!.grantKeyHash).toBeDefined()
  })

  it('retains the old grant until every placed daemon acknowledges the replacement', async () => {
    const control = new SpyControl()
    const relay = new SpyRelayControl()
    const app = build({ control, relay })
    await seedDaemon(prisma, DAEMON)
    await addLiveRelay(app)
    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'grant-rotation-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        memory: { provider: 'external', connectionId: connection.id }
      }
    })
    expect(created.statusCode).toBe(201)

    control.failMemoryUpsert = true
    const deferred = await app.app.inject({
      method: 'POST',
      url: `${CONNECTIONS}/${connection.id}/grant/rotate`
    })
    expect(deferred.statusCode).toBe(503)
    expect(await app.deps.repos.externalMemoryGrant.activeForConnection(connection.id)).toHaveLength(2)
    expect(relay.assigns.at(-1)?.grantKeyHashes).toHaveLength(2)
    expect(relay.unassigns).toHaveLength(0)

    control.failMemoryUpsert = false
    const retried = await app.app.inject({
      method: 'POST',
      url: `${CONNECTIONS}/${connection.id}/grant/rotate`
    })
    expect(retried.statusCode, retried.body).toBe(200)
    expect(retried.json()).toMatchObject({ revision: 3, status: 'probing' })
    expect(await app.deps.repos.externalMemoryGrant.activeForConnection(connection.id)).toHaveLength(1)
    expect(relay.unassigns).toHaveLength(1)
  })

  it('rejects an overlapping mutation instead of interleaving secret/revision/grant state', async () => {
    const app = build()
    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)
    const repo = app.deps.repos.externalMemoryConnection
    const update = repo.update.bind(repo)
    let entered!: () => void
    let resume!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (resume = resolve))
    repo.update = async (...args) => {
      entered()
      await blocked
      return update(...args)
    }

    const first = app.app.inject({
      method: 'PATCH',
      url: `${CONNECTIONS}/${connection.id}`,
      payload: { config: { projectId: 'serialized' } }
    })
    await started
    const overlapping = await app.app.inject({
      method: 'POST',
      url: `${CONNECTIONS}/${connection.id}/grant/rotate`
    })
    expect(overlapping.statusCode).toBe(409)
    resume()
    expect((await first).statusCode).toBe(200)
    expect(await repo.get(connection.id)).toMatchObject({ revision: 2, config: { projectId: 'serialized' } })
    expect(await app.deps.repos.externalMemoryGrant.activeForConnection(connection.id)).toHaveLength(1)
  })
})

describe('external-memory agent binding — placement and revocation', () => {
  it('serializes connection deletion against an agent binding commit', async () => {
    const app = build()
    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)
    const writer = app.deps.repos.agentConfig
    const create = writer.create.bind(writer)
    let entered!: () => void
    let resume!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const blocked = new Promise<void>((resolve) => (resume = resolve))
    writer.create = async (...args) => {
      entered()
      await blocked
      return create(...args)
    }

    const binding = app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'binding-race-agent',
        runtime: 'claude',
        memory: { provider: 'external', connectionId: connection.id }
      }
    })
    await started
    const deleting = await app.app.inject({ method: 'DELETE', url: `${CONNECTIONS}/${connection.id}` })
    expect(deleting.statusCode).toBe(409)
    expect((deleting.json() as { message: string }).message).toContain('being updated')
    resume()
    expect((await binding).statusCode).toBe(201)
    expect(await app.deps.repos.externalMemoryConnection.get(connection.id)).not.toBeNull()
  })

  it('pushes the private registry before AgentSpec, permits probing bootstrap, and removes it after unbind', async () => {
    const control = new SpyControl()
    const relay = new SpyRelayControl()
    const app = build({ control, relay })
    await seedDaemon(prisma, DAEMON)
    await addLiveRelay(app)
    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'external-memory-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        memory: {
          provider: 'external',
          connectionId: connection.id,
          recall: { mode: 'auto', topK: 5, maxBytes: 8192, timeoutMs: 1000 },
          capture: { mode: 'manual' }
        }
      }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id
    expect(control.events.map((event) => event.kind)).toEqual(['memory-upsert', 'agent-upsert'])
    const memoryEvent = control.events[0]!
    expect(memoryEvent.kind).toBe('memory-upsert')
    if (memoryEvent.kind !== 'memory-upsert') throw new Error('expected memory-upsert')
    expect(memoryEvent.spec).toMatchObject({
      connectionId: connection.id,
      transport: 'streamable-http',
      relayUrl: `https://relay.example/memory/${connection.id}`,
      config: { projectId: 'p1' },
      secretKeys: ['apiKey']
    })
    expect(JSON.stringify(memoryEvent.spec)).not.toContain('plugin.example')
    expect(JSON.stringify(memoryEvent.spec)).not.toContain('upstream-secret')

    const boundDelete = await app.app.inject({ method: 'DELETE', url: `${CONNECTIONS}/${connection.id}` })
    expect(boundDelete.statusCode).toBe(409)

    const unbound = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { memory: { provider: 'managed' } }
    })
    expect(unbound.statusCode).toBe(200)
    expect(control.events.map((event) => event.kind)).toEqual([
      'memory-upsert',
      'agent-upsert',
      'agent-upsert',
      'memory-remove'
    ])
    const removed = await app.app.inject({ method: 'DELETE', url: `${CONNECTIONS}/${connection.id}` })
    expect(removed.statusCode).toBe(204)
    expect(relay.unassigns.at(-1)).toEqual({ connectionId: connection.id, revision: 2 })
    expect(await app.deps.repos.externalMemoryConnection.get(connection.id)).toBeNull()
  })

  it('keeps the ordered AgentSpec hot-sync when a probe ACK is lost', async () => {
    const control = new SpyControl()
    control.failMemoryUpsert = true
    const app = build({ control })
    await seedDaemon(prisma, DAEMON)
    await addLiveRelay(app)
    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)

    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'probe-ack-lost-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        memory: { provider: 'external', connectionId: connection.id }
      }
    })

    // WebSocket delivery is ordered and the daemon inserts a probing registry
    // entry before awaiting conformance. A lost/rejected ACK must not strand the
    // durable AgentSpec until reconnect; static admission remains fail-closed.
    expect(created.statusCode).toBe(201)
    expect(control.events.map((event) => event.kind)).toEqual(['memory-upsert', 'agent-upsert'])
  })

  it('removes an otherwise-unused private registry entry when its bound agent is deleted', async () => {
    const control = new SpyControl()
    const app = build({ control })
    await seedDaemon(prisma, DAEMON)
    await addLiveRelay(app)
    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'deleted-external-memory-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        memory: { provider: 'external', connectionId: connection.id }
      }
    })
    expect(created.statusCode).toBe(201)
    const agentId = (created.json() as { id: string }).id
    control.events.length = 0

    const deleted = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })
    expect(deleted.statusCode).toBe(204)
    expect(control.events.map((event) => event.kind)).toEqual(['agent-remove', 'memory-remove'])
  })

  it('rejects an unknown/cross-org connection reference and a proven-invalid revision', async () => {
    const app = build()
    await seedDaemon(prisma, DAEMON)
    const missing = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'missing-memory-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        memory: { provider: 'external', connectionId: randomUUID() }
      }
    })
    expect(missing.statusCode).toBe(400)

    const installationId = await createInstallation(app)
    const connection = await createConnection(app, installationId)
    await app.deps.repos.externalMemoryConnection.updateProbeFact(connection.id, 1, {
      status: 'invalid',
      reasonCode: 'conformance_failed'
    })
    const invalid = await app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'invalid-memory-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        memory: { provider: 'external', connectionId: connection.id }
      }
    })
    expect(invalid.statusCode).toBe(400)
    expect((invalid.json() as { message: string }).message).toContain('conformance')
  })
})
