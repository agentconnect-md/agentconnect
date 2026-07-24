import { describe, expect, it } from 'vitest'
import {
  MEMORY_PLUGIN_PROFILE,
  MEMORY_RECALL_HARD_LIMITS,
  MemoryPluginCaptureInput,
  MemoryPluginManifest,
  MemoryPluginRecallInput,
  MemoryPluginRecallOutput
} from './memory-plugin.js'

const context = {
  requestId: 'request-1',
  connection: { id: 'connection-1', config: {} },
  scope: { kind: 'agent' as const, key: 'ac:agent:bot-a' }
}

describe('agentconnect.memory/v1 canonical schemas', () => {
  it('accepts the minimal conforming manifest and rejects duplicate capabilities', () => {
    const manifest = {
      profile: MEMORY_PLUGIN_PROFILE,
      plugin: { id: 'ai.example.memory', version: '1.0.0' },
      connection: { configSchema: { type: 'object', properties: {} }, secretFields: [] },
      capabilities: {
        scopes: ['agent'],
        operations: ['recall', 'capture'],
        asyncCapture: false,
        idempotency: 'operation-id'
      },
      limits: { maxQueryBytes: 4096, maxRecordBytes: 8192, maxBatchItems: 20 }
    }
    expect(MemoryPluginManifest.parse(manifest)).toEqual(manifest)
    expect(() =>
      MemoryPluginManifest.parse({
        ...manifest,
        capabilities: { ...manifest.capabilities, operations: ['recall', 'capture', 'capture'] }
      })
    ).toThrow()
  })

  it('pins recall budgets and validates canonical record scope', () => {
    expect(MemoryPluginRecallInput.parse({ context, query: 'where?', topK: 5, maxBytes: 8192 })).toMatchObject({
      topK: 5,
      maxBytes: 8192
    })
    expect(() =>
      MemoryPluginRecallInput.parse({
        context,
        query: 'where?',
        topK: MEMORY_RECALL_HARD_LIMITS.topK + 1,
        maxBytes: 8192
      })
    ).toThrow()
    expect(
      MemoryPluginRecallOutput.parse({
        records: [{ id: 'record-1', text: 'fact', scope: { kind: 'agent', key: 'ac:agent:bot-a' } }]
      })
    ).toMatchObject({ records: [{ id: 'record-1' }] })
  })

  it('allows capture observations only through the trusted context + stable operation id shape', () => {
    expect(
      MemoryPluginCaptureInput.parse({
        context,
        operationId: 'operation-1',
        turn: { turnId: 'turn-1', sessionId: 'session-1', input: 'remember', output: 'done' }
      })
    ).toMatchObject({ operationId: 'operation-1', turn: { turnId: 'turn-1' } })
    expect(() =>
      MemoryPluginCaptureInput.parse({
        context: { ...context, forged: true },
        operationId: 'operation-1',
        turn: { turnId: 'turn-1', input: '', output: '' }
      })
    ).toThrow()
  })
})
