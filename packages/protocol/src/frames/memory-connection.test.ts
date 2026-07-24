import { describe, expect, it } from 'vitest'
import { AgentMemoryBinding, MemoryConnectionFacts, MemoryConnectionSpec } from './memory-connection.js'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

describe('external-memory daemon-private frames', () => {
  it('defaults bounded agent recall/capture policy without accepting endpoints or secrets', () => {
    expect(AgentMemoryBinding.parse({ provider: 'external', connectionId: CONNECTION_ID })).toEqual({
      provider: 'external',
      connectionId: CONNECTION_ID,
      // A healthy remote Mem0 search can spend almost one second in the relay
      // alone. Keep enough end-to-end headroom for transport and parsing so the
      // default does not race a successful upstream response.
      recall: { mode: 'auto', topK: 5, maxBytes: 8192, timeoutMs: 3000 },
      capture: { mode: 'manual' }
    })
    expect(AgentMemoryBinding.parse({ provider: 'external', connectionId: CONNECTION_ID, capture: {} })).toMatchObject({
      capture: { mode: 'manual' }
    })
    expect(() =>
      AgentMemoryBinding.parse({ provider: 'external', connectionId: CONNECTION_ID, endpoint: 'https://plugin' })
    ).toThrow()
    expect(() =>
      AgentMemoryBinding.parse({
        provider: 'external',
        connectionId: CONNECTION_ID,
        recall: { mode: 'auto', topK: 21, maxBytes: 8192, timeoutMs: 1000 }
      })
    ).toThrow()
  })

  it('accepts a recall budget up to the cold-start ceiling and rejects above it', () => {
    // A local/self-hosted provider needs a budget past the old 3s cap; the CP
    // validates through this same schema, so the ceiling stays aligned end-to-end.
    expect(
      AgentMemoryBinding.parse({
        provider: 'external',
        connectionId: CONNECTION_ID,
        recall: { mode: 'auto', topK: 5, maxBytes: 8192, timeoutMs: 10_000 }
      })
    ).toMatchObject({ recall: { timeoutMs: 10_000 } })
    expect(() =>
      AgentMemoryBinding.parse({
        provider: 'external',
        connectionId: CONNECTION_ID,
        recall: { mode: 'auto', topK: 5, maxBytes: 8192, timeoutMs: 10_001 }
      })
    ).toThrow()
  })

  it('accepts only relay/grant/non-secret config + canonical manifest pins', () => {
    const value = {
      connectionId: CONNECTION_ID,
      revision: 1,
      transport: 'streamable-http' as const,
      relayUrl: `https://relay.example/memory/${CONNECTION_ID}`,
      grantKey: 'daemon-private-grant',
      config: { projectId: 'p1' },
      secretKeys: ['apiKey'],
      pin: {
        pluginId: 'ai.example.memory',
        profileMajor: 1,
        manifestDigest: `sha256:${'a'.repeat(64)}`,
        secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }]
      }
    }
    expect(MemoryConnectionSpec.parse(value)).toEqual(value)
    const { transport: _transport, ...legacy } = value
    expect(MemoryConnectionSpec.parse(legacy)).toEqual(value)
    expect(() => MemoryConnectionSpec.parse({ ...value, upstreamUrl: 'https://plugin.example' })).toThrow()
    expect(() =>
      MemoryConnectionSpec.parse({ ...value, pin: { ...value.pin, manifestDigest: 'a'.repeat(64) } })
    ).toThrow()
  })

  it('accepts only an allowlist ref plus a bounded daemon-private lease for stdio', () => {
    const value = {
      connectionId: CONNECTION_ID,
      revision: 2,
      transport: 'stdio' as const,
      commandRef: 'mem0-oss',
      config: {},
      secretKeys: ['apiKey'],
      secretLease: { values: { apiKey: 'daemon-private-value' } },
      pin: {
        pluginId: 'ai.mem0.memory.oss',
        profileMajor: 1 as const,
        secretHeaders: [{ name: 'apiKey', header: 'X-Mem0-Api-Key', required: true }]
      }
    }
    expect(MemoryConnectionSpec.parse(value)).toEqual(value)
    expect(() => MemoryConnectionSpec.parse({ ...value, commandRef: '../../tenant-command' })).toThrow()
    expect(() =>
      MemoryConnectionSpec.parse({
        ...value,
        secretKeys: ['apiKey', 'other'],
        secretLease: { values: value.secretLease.values }
      })
    ).toThrow()
    expect(() =>
      MemoryConnectionSpec.parse({
        ...value,
        secretLease: { values: { apiKey: 'x'.repeat(65 * 1024) } }
      })
    ).toThrow()
    expect(() =>
      MemoryConnectionSpec.parse({
        ...value,
        secretLease: { values: { apiKey: 'before\0after' } }
      })
    ).toThrow()
  })

  it('keeps facts metadata-only and revision-fenced', () => {
    const value = {
      connections: [
        {
          connectionId: CONNECTION_ID,
          revision: 3,
          pluginId: 'ai.example.memory',
          version: '1.2.3',
          profile: 'agentconnect.memory/v1',
          manifestDigest: `sha256:${'b'.repeat(64)}`,
          declaredEgressHosts: ['api.example-memory.com'],
          status: 'ready'
        }
      ]
    }
    expect(MemoryConnectionFacts.parse(value)).toEqual(value)
    expect(() =>
      MemoryConnectionFacts.parse({ connections: [{ ...value.connections[0], grantKey: 'must-not-cross-facts' }] })
    ).toThrow()
  })
})
