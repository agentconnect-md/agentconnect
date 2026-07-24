import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_PLUGIN_PROFILE,
  type MemoryConnectionFact,
  type MemoryConnectionSpec,
  type MemoryPluginManifest
} from '@agentconnect.md/protocol'
import { CpMemoryConnectionRegistry } from '../../src/cp/memory-connection-registry.js'
import type { MemoryPluginClient, MemoryPluginClientOptions } from '../../src/memory-plugin/client.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const DIGEST = `sha256:${'a'.repeat(64)}`
type RemoteMemoryConnectionSpec = Extract<MemoryConnectionSpec, { transport: 'streamable-http' }>

const manifest: MemoryPluginManifest = {
  profile: MEMORY_PLUGIN_PROFILE,
  plugin: { id: 'ai.example.memory', version: '1.2.3' },
  connection: {
    configSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', minLength: 1 } },
      required: ['projectId'],
      additionalProperties: false
    },
    secretFields: [{ name: 'apiKey', required: true, transportHeader: 'X-Api-Key' }]
  },
  capabilities: {
    scopes: ['agent'],
    operations: ['recall', 'capture'],
    asyncCapture: false,
    idempotency: 'operation-id'
  },
  limits: { maxQueryBytes: 4096, maxRecordBytes: 8192, maxBatchItems: 20 },
  declaredEgressHosts: ['api.example-memory.com']
}

function spec(over: Partial<RemoteMemoryConnectionSpec> = {}): RemoteMemoryConnectionSpec {
  return {
    connectionId: CONNECTION_ID,
    revision: 1,
    transport: 'streamable-http',
    relayUrl: `https://relay.example/memory/${CONNECTION_ID}`,
    grantKey: 'daemon-private-grant',
    config: { projectId: 'project-1' },
    secretKeys: ['apiKey'],
    pin: {
      pluginId: manifest.plugin.id,
      profileMajor: 1,
      manifestDigest: DIGEST,
      secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }]
    },
    ...over
  }
}

function fakeClient(over: Partial<MemoryPluginClient> = {}) {
  const close = vi.fn(async () => undefined)
  const client = {
    manifest,
    manifestDigest: DIGEST,
    hasTool: vi.fn(() => false),
    close,
    ...over
  } as unknown as MemoryPluginClient
  return { client, close }
}

describe('CpMemoryConnectionRegistry', () => {
  it('probes through the relay grant, validates pins/config/secrets, and emits body-free facts', async () => {
    const { client } = fakeClient()
    const facts: MemoryConnectionFact[][] = []
    const changed = vi.fn()
    const connect = vi.fn(async () => client)
    const registry = new CpMemoryConnectionRegistry({
      connect,
      onFacts: (snapshot) => facts.push(snapshot),
      onDefinitionChange: changed
    })

    registry.upsert(spec())
    expect(facts.at(-1)?.[0]).toMatchObject({ connectionId: CONNECTION_ID, revision: 1, status: 'probing' })
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('ready'))

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://relay.example/memory/${CONNECTION_ID}`,
        headers: [{ name: 'Authorization', value: 'Bearer daemon-private-grant' }],
        expectedPluginId: 'ai.example.memory',
        expectedProfileMajor: 1,
        expectedManifestDigest: DIGEST
      })
    )
    expect(registry.admissionError(CONNECTION_ID)).toBeUndefined()
    expect(registry.clientFor(CONNECTION_ID)).toBe(client)
    expect(changed).toHaveBeenCalledWith(CONNECTION_ID)
    expect(JSON.stringify(registry.facts())).not.toContain('daemon-private-grant')
    expect(JSON.stringify(registry.facts())).not.toContain('project-1')
    expect(registry.facts()[0]).toMatchObject({
      pluginId: 'ai.example.memory',
      version: '1.2.3',
      profile: MEMORY_PLUGIN_PROFILE,
      manifestDigest: DIGEST,
      declaredEgressHosts: ['api.example-memory.com'],
      status: 'ready'
    })
    const factEmits = facts.length
    registry.upsert(spec())
    expect(facts).toHaveLength(factEmits + 1)
    expect(facts.at(-1)?.[0]?.status).toBe('ready')
    expect(connect).toHaveBeenCalledTimes(1)
    await registry.close()
  })

  it('classifies conformance/config/secret contract failures as invalid without leaking details', async () => {
    const { client } = fakeClient()
    const registry = new CpMemoryConnectionRegistry({ connect: async () => client })
    registry.upsert(spec({ config: {} }))
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('invalid'))
    expect(registry.facts()[0]?.reasonCode).toBe('conformance_failed')
    expect(registry.clientFor(CONNECTION_ID)).toBeUndefined()

    registry.upsert(
      spec({
        revision: 2,
        pin: { ...spec().pin, secretHeaders: [{ name: 'apiKey', header: 'X-Wrong-Key', required: true }] }
      })
    )
    await vi.waitFor(() => expect(registry.facts()[0]).toMatchObject({ revision: 2, status: 'invalid' }))
    expect(registry.admissionError(CONNECTION_ID)).toContain('conformance')
    await registry.close()
  })

  it('resolves stdio only through the operator allowlist and injects mapped secrets into the child env', async () => {
    const { client } = fakeClient()
    const connect = vi.fn(async () => client)
    const registry = new CpMemoryConnectionRegistry({
      connect,
      stdioAllowlist: {
        'mem0-oss': {
          command: '/operator/bin/mem0-wrapper',
          args: ['--stdio'],
          env: [{ name: 'MEM0_DIALECT', value: 'oss' }],
          secretEnv: { apiKey: 'MEM0_API_KEY' }
        }
      }
    })

    registry.upsert({
      connectionId: CONNECTION_ID,
      revision: 1,
      transport: 'stdio',
      commandRef: 'mem0-oss',
      config: { projectId: 'project-1' },
      secretKeys: ['apiKey'],
      secretLease: { values: { apiKey: 'daemon-private-upstream-key' } },
      pin: spec().pin
    })
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('ready'))

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'stdio',
        command: '/operator/bin/mem0-wrapper',
        args: ['--stdio'],
        env: { MEM0_DIALECT: 'oss', MEM0_API_KEY: 'daemon-private-upstream-key' }
      })
    )
    expect(JSON.stringify(registry.facts())).not.toContain('daemon-private-upstream-key')
    await registry.close()
  })

  it('fails stdio admission without spawning when the command or secret mapping is not allowlisted', async () => {
    const { client } = fakeClient()
    const connect = vi.fn(async () => client)
    const localSpec: MemoryConnectionSpec = {
      connectionId: CONNECTION_ID,
      revision: 1,
      transport: 'stdio',
      commandRef: 'tenant-choice',
      config: { projectId: 'project-1' },
      secretKeys: ['apiKey'],
      secretLease: { values: { apiKey: 'private' } },
      pin: spec().pin
    }
    const registry = new CpMemoryConnectionRegistry({ connect, stdioAllowlist: {} })
    registry.upsert(localSpec)
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('invalid'))
    expect(registry.facts()[0]?.reasonCode).toBe('local_plugin_not_allowed')
    expect(connect).not.toHaveBeenCalled()
    registry.upsert({ ...localSpec, revision: 2, commandRef: 'constructor' })
    await vi.waitFor(() => expect(registry.facts()[0]).toMatchObject({ revision: 2, status: 'invalid' }))
    expect(registry.facts()[0]?.reasonCode).toBe('local_plugin_not_allowed')
    expect(connect).not.toHaveBeenCalled()

    const unmapped = new CpMemoryConnectionRegistry({
      connect,
      stdioAllowlist: { known: { command: 'wrapper', args: [], env: [], secretEnv: {} } }
    })
    unmapped.upsert({ ...localSpec, commandRef: 'known' })
    await vi.waitFor(() => expect(unmapped.facts()[0]?.status).toBe('invalid'))
    expect(unmapped.facts()[0]?.reasonCode).toBe('secret_delivery_unavailable')
    expect(connect).not.toHaveBeenCalled()

    const prototypeName = new CpMemoryConnectionRegistry({
      connect,
      stdioAllowlist: { known: { command: 'wrapper', args: [], env: [], secretEnv: {} } }
    })
    prototypeName.upsert({
      ...localSpec,
      commandRef: 'known',
      secretKeys: ['constructor'],
      secretLease: { values: { constructor: 'private' } }
    })
    await vi.waitFor(() => expect(prototypeName.facts()[0]?.status).toBe('invalid'))
    expect(prototypeName.facts()[0]?.reasonCode).toBe('secret_delivery_unavailable')
    expect(connect).not.toHaveBeenCalled()
    await registry.close()
    await unmapped.close()
    await prototypeName.close()
  })

  it('restarts a degraded stdio child after backoff without closing admission', async () => {
    const first = fakeClient()
    const replacement = fakeClient()
    let unexpectedClose: (() => void) | undefined
    const connect = vi
      .fn()
      .mockImplementationOnce(async (options: MemoryPluginClientOptions) => {
        unexpectedClose = options.onUnexpectedClose
        return first.client
      })
      .mockResolvedValueOnce(replacement.client)
    const registry = new CpMemoryConnectionRegistry({
      connect,
      retryDelayMs: 1,
      stdioAllowlist: { local: { command: 'wrapper', args: [], env: [], secretEnv: { apiKey: 'MEM0_API_KEY' } } }
    })
    registry.upsert({
      connectionId: CONNECTION_ID,
      revision: 1,
      transport: 'stdio',
      commandRef: 'local',
      config: { projectId: 'project-1' },
      secretKeys: ['apiKey'],
      secretLease: { values: { apiKey: 'private' } },
      pin: spec().pin
    })
    await vi.waitFor(() => expect(registry.clientFor(CONNECTION_ID)).toBe(first.client))

    unexpectedClose?.()
    await Promise.resolve()
    expect(registry.facts()[0]?.reasonCode).toBe('plugin_process_exited')
    expect(registry.admissionError(CONNECTION_ID)).toBeUndefined()
    await vi.waitFor(() => expect(registry.clientFor(CONNECTION_ID)).toBe(replacement.client))
    expect(first.close).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledTimes(2)
    await registry.close()
  })

  it('classifies transport failures as degraded but fails admission until some exact definition was verified', async () => {
    const registry = new CpMemoryConnectionRegistry({
      connect: async () => {
        throw new Error('upstream body must stay private')
      }
    })
    registry.upsert(spec())
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('degraded'))
    expect(registry.facts()[0]?.reasonCode).toBe('plugin_unavailable')
    expect(JSON.stringify(registry.facts())).not.toContain('upstream body')
    expect(registry.admissionError(CONNECTION_ID)).toContain('has not completed validation')
    await registry.close()
  })

  it('uses optional health without making a transient health outage fail admission', async () => {
    const health = vi.fn(async () => {
      throw new Error('temporary backend outage')
    })
    const { client } = fakeClient({
      hasTool: vi.fn((name: string) => name === 'agentconnect_memory_health'),
      health
    } as Partial<MemoryPluginClient>)
    const registry = new CpMemoryConnectionRegistry({ connect: async () => client })
    registry.upsert(spec())
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('degraded'))
    expect(registry.facts()[0]?.reasonCode).toBe('health_unavailable')
    expect(registry.clientFor(CONNECTION_ID)).toBe(client)
    expect(registry.admissionError(CONNECTION_ID)).toBeUndefined()
    expect(health).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          connection: { id: CONNECTION_ID, config: { projectId: 'project-1' } },
          scope: { kind: 'agent', key: `ac:agent:probe-${CONNECTION_ID}` }
        })
      })
    )
    await registry.close()
  })

  it('treats an optional health invalid verdict as a static admission failure', async () => {
    const { client, close } = fakeClient({
      hasTool: vi.fn((name: string) => name === 'agentconnect_memory_health'),
      health: vi.fn(async () => ({ status: 'invalid' as const, reasonCode: 'credential_rejected' }))
    } as Partial<MemoryPluginClient>)
    const registry = new CpMemoryConnectionRegistry({ connect: async () => client })
    registry.upsert(spec())
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('invalid'))
    expect(registry.facts()[0]?.reasonCode).toBe('health_invalid')
    expect(JSON.stringify(registry.facts())).not.toContain('credential_rejected')
    expect(registry.clientFor(CONNECTION_ID)).toBeUndefined()
    expect(registry.admissionError(CONNECTION_ID)).toContain('conformance')
    expect(close).toHaveBeenCalledOnce()
    await registry.close()
  })

  it('retries a transient initial probe without requiring a CP reconnect', async () => {
    const { client } = fakeClient()
    const connect = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(client)
    const registry = new CpMemoryConnectionRegistry({ connect, retryDelayMs: 1 })
    registry.upsert(spec())
    await vi.waitFor(() => expect(registry.clientFor(CONNECTION_ID)).toBe(client))
    expect(connect).toHaveBeenCalledTimes(2)
    expect(registry.facts()[0]?.status).toBe('ready')
    await registry.close()
  })

  it('uses the live-upsert acknowledgement as a completed-probe admission barrier', async () => {
    let resolve!: (client: MemoryPluginClient) => void
    const pending = new Promise<MemoryPluginClient>((done) => {
      resolve = done
    })
    const { client } = fakeClient()
    const registry = new CpMemoryConnectionRegistry({ connect: () => pending })
    registry.upsert(spec())
    const admission = registry.waitForAdmission(CONNECTION_ID)
    expect(registry.admissionError(CONNECTION_ID)).toContain('probing')
    resolve(client)
    await expect(admission).resolves.toBeUndefined()
    await registry.close()
  })

  it('generation-fences a slow stale probe across grant rotation', async () => {
    let resolveFirst!: (client: MemoryPluginClient) => void
    const first = new Promise<MemoryPluginClient>((resolve) => {
      resolveFirst = resolve
    })
    const old = fakeClient()
    const fresh = fakeClient()
    const connect = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(fresh.client)
    const registry = new CpMemoryConnectionRegistry({ connect })

    registry.upsert(spec())
    registry.upsert(spec({ revision: 2, grantKey: 'rotated-grant' }))
    await vi.waitFor(() => expect(registry.clientFor(CONNECTION_ID)).toBe(fresh.client))
    resolveFirst(old.client)
    await vi.waitFor(() => expect(old.close).toHaveBeenCalledOnce())
    expect(registry.clientFor(CONNECTION_ID)).toBe(fresh.client)
    await registry.close()
  })

  it('ignores a delayed lower-revision definition instead of rolling the registry back', async () => {
    const { client } = fakeClient()
    const connect = vi.fn(async () => client)
    const registry = new CpMemoryConnectionRegistry({ connect })
    registry.upsert(spec({ revision: 2, config: { projectId: 'new' } }))
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('ready'))

    registry.upsert(spec({ revision: 1, config: { projectId: 'stale' } }))
    expect(registry.specFor(CONNECTION_ID)).toMatchObject({ revision: 2, config: { projectId: 'new' } })
    expect(connect).toHaveBeenCalledTimes(1)
    await registry.close()
  })

  it('rejects two different definitions at the same revision', async () => {
    const { client } = fakeClient()
    const registry = new CpMemoryConnectionRegistry({ connect: async () => client })
    registry.upsert(spec({ revision: 2, config: { projectId: 'first' } }))

    expect(registry.upsert(spec({ revision: 2, config: { projectId: 'equivocated' } }))).toBe(false)
    expect(registry.specFor(CONNECTION_ID)).toMatchObject({ revision: 2, config: { projectId: 'first' } })
    await registry.close()
  })

  it('full-replace/remove closes clients; verified runtime degradation remains fail-open', async () => {
    const one = fakeClient()
    const registry = new CpMemoryConnectionRegistry({ connect: async () => one.client })
    registry.converge([spec()])
    await vi.waitFor(() => expect(registry.facts()[0]?.status).toBe('ready'))

    registry.markDegraded(CONNECTION_ID, 'recall_unavailable')
    expect(registry.facts()[0]).toMatchObject({ status: 'degraded', reasonCode: 'recall_unavailable' })
    expect(registry.admissionError(CONNECTION_ID)).toBeUndefined()
    expect(registry.clientFor(CONNECTION_ID)).toBe(one.client)

    // A successful records-page read must not make a failed per-turn recall
    // look recovered. Only success in the operation that owns the current
    // reason may clear it.
    registry.markRecovered(CONNECTION_ID, ['admin_list_unavailable'])
    expect(registry.facts()[0]).toMatchObject({ status: 'degraded', reasonCode: 'recall_unavailable' })
    registry.markRecovered(CONNECTION_ID, ['recall_unavailable'])
    expect(registry.facts()[0]?.status).toBe('ready')
    expect(registry.facts()[0]?.reasonCode).toBeUndefined()

    registry.converge([])
    await vi.waitFor(() => expect(one.close).toHaveBeenCalledOnce())
    expect(registry.facts()).toEqual([])
    expect(registry.admissionError(CONNECTION_ID)).toContain('not installed')
    await registry.close()
  })
})
