/**
 * External-memory connection convergence + facts trust boundary.
 *
 * A register snapshot must expose only relay-side credentials for connections
 * referenced by this daemon's agents. Later facts are accepted only from that
 * owning daemon and only for the current revision.
 */
import { describe, expect, it, vi } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import {
  PgExternalMemoryConnectionRepo,
  PgExternalMemoryConnectionSecretStore,
  PgExternalMemoryGrantRepo,
  PgMemoryPluginInstallationRepo
} from '../../src/persistence/repositories/memory-connection.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const DAEMON_1 = 'a1111111-1111-4111-8111-111111111111'
const DAEMON_2 = 'a2222222-2222-4222-8222-222222222222'
const AGENT_1 = 'b1111111-1111-4111-8111-111111111111'
const AGENT_2 = 'b2222222-2222-4222-8222-222222222222'
const RELAY = 'c1111111-1111-4111-8111-111111111111'

function authPayload(token: string) {
  return { apiKey: token, daemonId: DAEMON_1, agentVersion: '1.7.0' }
}

function registerPayload() {
  return {
    host: 'host-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [] }
  }
}

async function fixture() {
  const installations = new PgMemoryPluginInstallationRepo(prisma)
  const connections = new PgExternalMemoryConnectionRepo(prisma)
  const secrets = new PgExternalMemoryConnectionSecretStore(prisma, new PlaintextSecretCipher())
  const grants = new PgExternalMemoryGrantRepo(prisma, new PlaintextSecretCipher())
  const installation = await installations.create({
    orgId: OrgId(DEFAULT_ORG_ID),
    pluginId: 'ai.example.memory',
    transport: 'streamable-http',
    endpoint: 'https://plugin.example/mcp',
    pinnedProfileMajor: 1,
    expectedManifestDigest: `sha256:${'a'.repeat(64)}`,
    secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }],
    createdByUserId: DEFAULT_OWNER_ID
  })
  const connection1 = await connections.create({
    orgId: OrgId(DEFAULT_ORG_ID),
    installationId: installation.id,
    config: { projectId: 'p1' },
    createdByUserId: DEFAULT_OWNER_ID
  })
  const connection2 = await connections.create({
    orgId: OrgId(DEFAULT_ORG_ID),
    installationId: installation.id,
    config: { projectId: 'p2' },
    createdByUserId: DEFAULT_OWNER_ID
  })
  await secrets.put(OrgId(DEFAULT_ORG_ID), connection1.id, { apiKey: 'upstream-secret-1' })
  await secrets.put(OrgId(DEFAULT_ORG_ID), connection2.id, { apiKey: 'upstream-secret-2' })
  const grant1 = await grants.mintFor(OrgId(DEFAULT_ORG_ID), connection1.id)
  await grants.mintFor(OrgId(DEFAULT_ORG_ID), connection2.id)

  await seedDaemon(prisma, DAEMON_1)
  await seedDaemon(prisma, DAEMON_2)
  await seedAgent(prisma, AGENT_1, { daemonId: DAEMON_1 })
  await seedAgent(prisma, AGENT_2, { daemonId: DAEMON_2 })
  await prisma.agent.update({
    where: { id: AGENT_1 },
    data: { runtimeOverrides: { memory: { provider: 'external', connectionId: connection1.id } } }
  })
  await prisma.agent.update({
    where: { id: AGENT_2 },
    data: { runtimeOverrides: { memory: { provider: 'external', connectionId: connection2.id } } }
  })
  return { connections, connection1, connection2, grant1 }
}

describe('facts/memory-connections — daemon-scoped and revision-fenced', () => {
  it('reconciles a local stdio secret lease without requiring a relay or grant', async () => {
    const installations = new PgMemoryPluginInstallationRepo(prisma)
    const connections = new PgExternalMemoryConnectionRepo(prisma)
    const secrets = new PgExternalMemoryConnectionSecretStore(prisma, new PlaintextSecretCipher())
    const installation = await installations.create({
      orgId: OrgId(DEFAULT_ORG_ID),
      pluginId: 'ai.example.memory.stdio',
      transport: 'stdio',
      commandRef: 'operator-mem0',
      pinnedProfileMajor: 1,
      secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }],
      createdByUserId: DEFAULT_OWNER_ID
    })
    const connection = await connections.create({
      orgId: OrgId(DEFAULT_ORG_ID),
      installationId: installation.id,
      config: { projectId: 'local' },
      createdByUserId: DEFAULT_OWNER_ID
    })
    await secrets.put(OrgId(DEFAULT_ORG_ID), connection.id, { apiKey: 'daemon-private-local-secret' })
    await seedDaemon(prisma, DAEMON_1)
    await seedAgent(prisma, AGENT_1, { daemonId: DAEMON_1 })
    await prisma.agent.update({
      where: { id: AGENT_1 },
      data: { runtimeOverrides: { memory: { provider: 'external', connectionId: connection.id } } }
    })

    const h = buildWsHarness(prisma)
    const token = await h.mintToken(DAEMON_1)
    const { stub } = h.connect()
    stub.inject('auth', authPayload(token))
    await stub.expectFrame('auth/ok')
    stub.inject('register', registerPayload())
    const registered = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(registered)) throw new Error('expected register/ok')
    expect(registered.payload.memoryConnections).toEqual([
      {
        connectionId: connection.id,
        revision: 1,
        transport: 'stdio',
        commandRef: 'operator-mem0',
        config: { projectId: 'local' },
        secretKeys: ['apiKey'],
        secretLease: { values: { apiKey: 'daemon-private-local-secret' } },
        pin: {
          pluginId: 'ai.example.memory.stdio',
          profileMajor: 1,
          secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }]
        }
      }
    ])
    expect(JSON.stringify(registered.payload.memoryConnections)).not.toContain('relayUrl')
    expect(JSON.stringify(registered.payload.memoryConnections)).not.toContain('grantKey')
    expect(JSON.stringify(registered.payload.memoryConnections)).not.toContain('/usr/bin')
  })

  it('reconciles only referenced private specs and accepts facts only for this daemon', async () => {
    const { connections, connection1, connection2, grant1 } = await fixture()
    const h = buildWsHarness(prisma, {
      relays: [{ relayId: RELAY, url: 'wss://relay.example/rd' }]
    })
    const token = await h.mintToken(DAEMON_1)
    const { stub } = h.connect()
    stub.inject('auth', authPayload(token))
    await stub.expectFrame('auth/ok')
    stub.inject('register', registerPayload())
    const registered = await stub.expectFrame('register/ok')
    if (!isFrame('register/ok')(registered)) throw new Error('expected register/ok')

    expect(registered.payload.memoryConnections).toEqual([
      {
        connectionId: connection1.id,
        revision: 1,
        transport: 'streamable-http',
        relayUrl: `https://relay.example/memory/${connection1.id}`,
        grantKey: grant1.key,
        config: { projectId: 'p1' },
        secretKeys: ['apiKey'],
        pin: {
          pluginId: 'ai.example.memory',
          profileMajor: 1,
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }]
        }
      }
    ])
    // The daemon projection carries neither the upstream endpoint nor secret.
    expect(JSON.stringify(registered.payload.memoryConnections)).not.toContain('plugin.example')
    expect(JSON.stringify(registered.payload.memoryConnections)).not.toContain('upstream-secret')

    stub.inject('facts/memory-connections', {
      connections: [
        {
          connectionId: connection1.id,
          revision: 1,
          pluginId: 'ai.example.memory',
          version: '1.2.3',
          profile: 'agentconnect.memory/v1',
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          capabilities: {
            scopes: ['agent'],
            operations: ['recall', 'capture'],
            asyncCapture: false,
            idempotency: 'none'
          },
          declaredEgressHosts: ['api.example-memory.com'],
          status: 'ready'
        },
        {
          connectionId: connection2.id,
          revision: 1,
          pluginId: 'ai.example.memory',
          status: 'invalid',
          reasonCode: 'conformance_failed'
        }
      ]
    })

    await vi.waitFor(async () => {
      expect(await connections.get(DEF_ORG, connection1.id)).toMatchObject({
        status: 'ready',
        probedRevision: 1,
        declaredEgressHosts: ['api.example-memory.com']
      })
    })
    // Connection 2 belongs to DAEMON_2: a fact from DAEMON_1 cannot mutate it.
    expect(await connections.get(DEF_ORG, connection2.id)).toMatchObject({ status: 'probing', probedRevision: null })

    await connections.update(DEF_ORG, connection1.id, { config: { projectId: 'changed' } })
    stub.inject('facts/memory-connections', {
      connections: [
        {
          connectionId: connection1.id,
          revision: 1,
          pluginId: 'ai.example.memory',
          status: 'invalid',
          reasonCode: 'stale'
        }
      ]
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await connections.get(DEF_ORG, connection1.id)).toMatchObject({
      revision: 2,
      status: 'probing',
      probedRevision: null
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })
})
