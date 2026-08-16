import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalStore } from '../src/store/local-store.js'
import { MemoryCaptureOutbox, type MemoryCapturePumpRegistry } from '../src/memory-plugin/outbox.js'
import type { MemoryPluginMetrics } from '../src/memory-plugin/metrics.js'
import {
  MANAGED_DISTILL_PLUGIN_ID,
  managedDistillCapture,
  managedDistillConnectionId,
  withManagedDistill
} from '../src/agents/managed-distill-outbox.js'

const metrics: MemoryPluginMetrics = {
  recall: vi.fn(),
  recallInjected: vi.fn(),
  captureState: vi.fn(),
  outbox: vi.fn()
}

const noPlugins: MemoryCapturePumpRegistry = {
  connectionIds: () => [],
  clientFor: () => undefined,
  specFor: () => undefined,
  markDegraded: vi.fn(),
  markRecovered: vi.fn()
}

function store(): LocalStore {
  return new LocalStore(join(mkdtempSync(join(tmpdir(), 'ac-managed-distill-')), 'local.sqlite'))
}

describe('managed distillation through the capture outbox', () => {
  it('waits without spending attempts while the sandbox is down, then distills once it is bound', async () => {
    let bound = false
    const distill = vi.fn(async () => {})
    const db = store()
    const outbox = new MemoryCaptureOutbox(
      db,
      withManagedDistill(noPlugins, { agentIds: () => ['bot-a'], reachable: () => bound, distill }),
      { metrics, unavailableRetryMs: 5 }
    )
    outbox.start()
    const queued = outbox.enqueue(
      managedDistillCapture({ agentId: 'bot-a', turnId: 'turn-1', sessionId: 'sess-1', input: 'hi', output: 'hello' })
    )
    expect(queued.status).toBe('inserted')
    // Deferred, not attempted: the pump found no client for the tree and kept the row pending.
    await vi.waitFor(() => expect(db.getMemoryCapture(queued.operationId)?.reasonCode).toBe('connection_unavailable'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(distill).not.toHaveBeenCalled()
    expect(db.getMemoryCapture(queued.operationId)).toMatchObject({
      state: 'pending',
      attempts: 0,
      connectionId: managedDistillConnectionId('bot-a'),
      pluginId: MANAGED_DISTILL_PLUGIN_ID
    })

    // The sandbox binds: the daemon wakes the pump, and the deferred turn is distilled exactly once.
    bound = true
    outbox.wake()
    await vi.waitFor(() => expect(db.getMemoryCapture(queued.operationId)?.state).toBe('completed'))
    expect(distill).toHaveBeenCalledTimes(1)
    expect(distill).toHaveBeenCalledWith('bot-a', {
      turnId: 'turn-1',
      sessionId: 'sess-1',
      input: 'hi',
      output: 'hello'
    })
    // The same turn enqueued again is the same operation.
    expect(
      outbox.enqueue(
        managedDistillCapture({ agentId: 'bot-a', turnId: 'turn-1', sessionId: 'sess-1', input: 'hi', output: 'hello' })
      ).status
    ).toBe('duplicate')
    await outbox.stop()
    db.close()
  })

  it('leaves plugin connections to the plugin registry and drains only the agents this member holds', async () => {
    const base: MemoryCapturePumpRegistry = { ...noPlugins, connectionIds: () => ['plugin-1'] }
    const registry = withManagedDistill(base, {
      agentIds: () => ['bot-a'],
      reachable: () => true,
      distill: async () => {}
    })
    expect(registry.connectionIds()).toEqual(['plugin-1', managedDistillConnectionId('bot-a')])
    expect(registry.clientFor('plugin-1')).toBeUndefined()
    expect(registry.clientFor(managedDistillConnectionId('bot-a'))?.manifest.plugin.id).toBe(MANAGED_DISTILL_PLUGIN_ID)
    expect(registry.specFor(managedDistillConnectionId('bot-a'))).toEqual({ revision: 1 })
    registry.markDegraded(managedDistillConnectionId('bot-a'), 'x')
    expect(noPlugins.markDegraded).not.toHaveBeenCalled()
  })
})
