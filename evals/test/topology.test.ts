import { describe, expect, it } from 'vitest'
import { CollabRoutesSnapshot } from '../../packages/protocol/src/index.js'
import { compileTopology, deterministicUuid } from '../games/topology.js'
import { countingManifest } from '../games/engine.js'
import type { GameTopologyManifest } from '../games/types.js'

const AGENTS = ['agent-a', 'agent-b', 'agent-c', 'agent-d']

describe('topology compiler (§5.1) — aliases become protocol-valid concrete identifiers', () => {
  it('emits wire-schema-valid uuids for agents, integrations, and the daemon', () => {
    const topology = compileTopology(countingManifest({ seed: 42, agents: AGENTS }))
    // RFC-4122 version 4, variant 10 — the shape zod's `uuid()` wire checks accept.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(topology.daemonId).toMatch(uuid)
    for (const agent of topology.agents) expect(agent.agentId).toMatch(uuid)
    for (const integration of topology.integrations) {
      expect(integration.integrationId).toMatch(uuid)
    }
    // The compiled snapshot round-trips the production wire schema.
    expect(() => CollabRoutesSnapshot.parse(topology.collabRoutes)).not.toThrow()
  })

  it('produces platform-shaped room coordinates and a complete alias map', () => {
    const topology = compileTopology(countingManifest({ seed: 42, agents: AGENTS }))
    const room = topology.rooms[0]!
    expect(room.channel).toMatch(/^C[A-Z0-9]{10}$/)
    expect(room.thread).toMatch(/^\d{10}\.\d{6}$/)
    expect(room.memberAgentIds).toHaveLength(4)
    expect(topology.aliasMap.rooms['counting-room']).toEqual({ channel: room.channel, thread: room.thread })
    for (const alias of AGENTS) {
      expect(topology.aliasMap.agents[alias]).toBe(topology.agents.find((a) => a.alias === alias)!.agentId)
    }
  })

  it('is deterministic per seed and distinct across seeds', () => {
    const a = compileTopology(countingManifest({ seed: 42, agents: AGENTS }))
    const b = compileTopology(countingManifest({ seed: 42, agents: AGENTS }))
    const c = compileTopology(countingManifest({ seed: 43, agents: AGENTS }))
    expect(a).toEqual(b)
    expect(a.agents[0]!.agentId).not.toBe(c.agents[0]!.agentId)
    expect(a.rooms[0]!.channel).not.toBe(c.rooms[0]!.channel)
    expect(deterministicUuid(1, 'x')).toBe(deterministicUuid(1, 'x'))
    expect(deterministicUuid(1, 'x')).not.toBe(deterministicUuid(2, 'x'))
  })

  it('gives a bridge identity one integration per platform reaching both same-platform rooms', () => {
    const manifest: GameTopologyManifest = {
      game: 'bridge-fixture',
      seed: 5,
      agents: [{ id: 'agent-a' }, { id: 'bridge-x' }, { id: 'agent-c' }],
      rooms: [
        { id: 'discord-origin', platform: 'discord', members: ['agent-a', 'bridge-x'] },
        { id: 'slack-support', platform: 'slack', members: ['bridge-x', 'agent-c'] },
        { id: 'slack-second', platform: 'slack', members: ['bridge-x'] }
      ]
    }
    const topology = compileTopology(manifest)
    const bridgeIntegrations = topology.integrations.filter((i) => i.agentAlias === 'bridge-x')
    // One per platform: discord + slack (the slack one reaches BOTH slack rooms).
    expect(bridgeIntegrations.map((i) => i.platform).sort()).toEqual(['discord', 'slack'])
    const slackIntegration = bridgeIntegrations.find((i) => i.platform === 'slack')!
    expect(slackIntegration.bindChannels).toHaveLength(2)
  })

  it('rejects a room naming an unknown agent alias', () => {
    expect(() =>
      compileTopology({
        game: 'broken',
        seed: 1,
        agents: [{ id: 'agent-a' }],
        rooms: [{ id: 'room', platform: 'slack', members: ['agent-a', 'ghost'] }]
      })
    ).toThrow(/unknown agent alias "ghost"/)
  })
})
