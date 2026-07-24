import { describe, it, expect } from 'vitest'
import { CpRoutingLayer, type CpRoutingSnapshot } from '../src/router/cp-routing-layer.js'
import type { RouteAssign, RouteUpdate } from '@agentconnect.md/protocol'

function memIo() {
  let saved: CpRoutingSnapshot | undefined
  return {
    load: () => saved,
    save: (s: CpRoutingSnapshot) => {
      saved = s
    },
    get saved() {
      return saved
    }
  }
}
const assign = (channel: string, agentId: string): RouteAssign => ({
  sessionKey: { platform: 'slack', channel },
  agentId,
  workspaceId: '00000000-0000-4000-8000-000000000000',
  bindRules: [{ match: { kind: 'auto' } }]
})

describe('CpRoutingLayer', () => {
  it('upsertAssign stores per-session rules and persists', () => {
    const io = memIo()
    const layer = new CpRoutingLayer(io)
    layer.upsertAssign(assign('C1', 'agentA'))
    expect(layer.effectiveRules()).toHaveLength(1)
    expect(layer.effectiveRules()[0]).toMatchObject({
      agentId: 'agentA',
      scope: { channel: 'C1' },
      match: { kind: 'auto' }
    })
    expect(io.saved).toBeDefined()
  })

  it('applyUpdate replaces global rules only when routingEpoch >= cached (idempotent)', () => {
    const layer = new CpRoutingLayer(memIo())
    const u = (epoch: number, agentId: string): RouteUpdate => ({
      routingEpoch: epoch,
      rules: [{ match: { kind: 'dm' }, agentId }]
    })
    layer.applyUpdate(u(2, 'a'))
    expect(layer.routingEpoch).toBe(2)
    layer.applyUpdate(u(1, 'stale')) // older — discarded
    expect(layer.effectiveRules().find((r) => r.agentId === 'stale')).toBeUndefined()
    layer.applyUpdate(u(3, 'b')) // newer — replaces
    expect(layer.effectiveRules().some((r) => r.agentId === 'b')).toBe(true)
    expect(layer.effectiveRules().some((r) => r.agentId === 'a')).toBe(false)
  })

  it('converge makes assignments exactly the snapshot set and applies drop', () => {
    const layer = new CpRoutingLayer(memIo())
    layer.upsertAssign(assign('C1', 'a'))
    layer.upsertAssign(assign('C2', 'b'))
    layer.converge({ routingEpoch: 5, assignments: [assign('C2', 'b'), assign('C3', 'c')], drop: { assignments: [] } })
    const channels = layer
      .effectiveRules()
      .map((r) => r.scope.channel)
      .sort()
    expect(channels).toEqual(['C2', 'C3'])
    expect(layer.routingEpoch).toBe(5)
  })

  it('rehydrates from a persisted snapshot via load()', () => {
    const io = memIo()
    new CpRoutingLayer(io).upsertAssign(assign('C1', 'a'))
    const reloaded = new CpRoutingLayer(io) // load() returns the saved snapshot
    expect(reloaded.effectiveRules()).toHaveLength(1)
  })

  it('applyUpdate same-epoch re-apply replaces globalRules (idempotency applies only to stale epochs)', () => {
    const layer = new CpRoutingLayer(memIo())
    const u = (epoch: number, agentId: string): RouteUpdate => ({
      routingEpoch: epoch,
      rules: [{ match: { kind: 'dm' }, agentId }]
    })
    layer.applyUpdate(u(2, 'a'))
    expect(layer.effectiveRules().some((r) => r.agentId === 'a')).toBe(true)
    // Same epoch re-apply replaces globalRules — not discarded
    layer.applyUpdate(u(2, 'b'))
    expect(layer.effectiveRules().some((r) => r.agentId === 'b')).toBe(true)
    expect(layer.effectiveRules().some((r) => r.agentId === 'a')).toBe(false)
    expect(layer.routingEpoch).toBe(2)
  })

  it('converge preserves globalRules and drops named assignments', () => {
    const layer = new CpRoutingLayer(memIo())
    const u = (epoch: number, agentId: string): RouteUpdate => ({
      routingEpoch: epoch,
      rules: [{ match: { kind: 'dm' }, agentId }]
    })
    // Establish a global rule via route/update
    layer.applyUpdate(u(2, 'globalAgent'))
    // Upsert two session assignments
    layer.upsertAssign(assign('C1', 'a'))
    layer.upsertAssign(assign('C2', 'b'))
    // converge: snapshot includes only C2; drop names C1's sessionKey string
    layer.converge({ routingEpoch: 5, assignments: [assign('C2', 'b')], drop: { assignments: ['slack:C1:-'] } })
    const channels = layer
      .effectiveRules()
      .map((r) => r.scope?.channel)
      .filter(Boolean)
      .sort()
    expect(channels).toEqual(['C2'])
    // globalRules must still be present
    expect(layer.effectiveRules().some((r) => r.agentId === 'globalAgent')).toBe(true)
    expect(layer.routingEpoch).toBe(5)
  })
})
