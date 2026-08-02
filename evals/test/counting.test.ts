import { describe, expect, it } from 'vitest'
import { CountingGame } from '../games/counting.js'
import { countingManifest } from '../games/engine.js'
import { compileTopology } from '../games/topology.js'
import { ArenaWorld } from '../games/world.js'

const AGENTS = ['agent-a', 'agent-b', 'agent-c', 'agent-d']

function fixture(target = 3) {
  const topology = compileTopology(countingManifest({ seed: 9, agents: AGENTS }))
  const world = new ArenaWorld(topology)
  const game = new CountingGame({ world, roomAlias: 'counting-room', target })
  const room = topology.rooms[0]!
  const integrationOf = (alias: string) => topology.integrations.find((i) => i.agentAlias === alias)!
  const reply = async (alias: string, text: string) => {
    const integration = integrationOf(alias)
    return world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: integration.integrationId,
      channel: room.channel,
      thread: room.thread,
      identity: { agentAuthorId: integration.agentId },
      text
    })
  }
  return { topology, world, game, room, reply, integrationOf }
}

describe('same-room counting referee (§10.1)', () => {
  it('opens with one start broadcast fanned to every member integration under one message id', () => {
    const { game, room } = fixture()
    const wave = game.nextDeliveries()
    expect(wave.platformEvents).toHaveLength(4)
    expect(new Set(wave.platformEvents.map((event) => event.integrationId)).size).toBe(4)
    expect(new Set(wave.platformEvents.map((event) => event.payload.messageId)).size).toBe(1)
    expect(wave.platformEvents[0]!.payload.channel).toBe(room.channel)
    expect(wave.platformEvents[0]!.payload.thread).toBe(room.thread)
    expect(wave.platformEvents[0]!.payload.text).toContain('Next expected number: 1')
    expect(wave.platformEvents[0]!.payload.sender.isBot).toBeFalsy()
  })

  it('atomically accepts the first valid candidate in sequence order and relays the canonical event', async () => {
    const { game, reply } = fixture()
    game.nextDeliveries()
    await reply('agent-a', '1')
    await reply('agent-b', '1')
    await reply('agent-c', '2')
    game.applyEffects(game.drainOutboundEffects())
    const verdict = game.verdict()
    // agent-a scored 1; agent-b's duplicate is stale; agent-c's 2 is next and valid.
    expect(verdict.outcome.acceptedPrefix).toBe(2)
    expect(verdict.outcome.acceptedBy).toEqual(['agent-a', 'agent-c'])
    expect(verdict.metrics.collisions).toBe(1)
    const relay = game.nextDeliveries()
    expect(relay.platformEvents[0]!.payload.text).toContain('Accepted: 1 from agent-a')
    expect(relay.platformEvents[0]!.payload.text).toContain('Next expected number: 2')
  })

  it('rejects skips, stale numbers, and consecutive scoring; waiting is legal', async () => {
    const { game, reply, world } = fixture()
    game.nextDeliveries()
    await reply('agent-a', '1')
    await reply('agent-b', '3') // skip → wrong_number
    game.applyEffects(game.drainOutboundEffects())
    await reply('agent-a', '2') // no agent scores twice consecutively
    await reply('agent-a', 'thinking about it') // noise, not a candidate
    await reply('agent-c', '1') // stale
    await reply('agent-d', '2') // valid
    game.applyEffects(game.drainOutboundEffects())
    const verdict = game.verdict()
    expect(verdict.outcome.acceptedBy).toEqual(['agent-a', 'agent-d'])
    const reasons = world
      .events()
      .filter((event) => event.type === 'count.candidate' && !event.accepted)
      .map((event) => event.reason)
    expect(reasons).toEqual(['wrong_number', 'consecutive_scorer', 'stale'])
    expect(verdict.metrics.noiseReplies).toBe(1)
  })

  it('completes at the target, stays referee-consistent, and reports participation entropy', async () => {
    const { game, reply } = fixture(3)
    game.nextDeliveries()
    for (const [step, alias] of (['agent-a', 'agent-b', 'agent-c'] as const).entries()) {
      await reply(alias, String(step + 1))
      game.applyEffects(game.drainOutboundEffects())
      // Consume the relay wave the acceptance queued (as the engine loop would).
      if (!game.isTerminal()) expect(game.nextDeliveries().platformEvents.length).toBeGreaterThan(0)
    }
    expect(game.isTerminal()).toBe(true)
    const verdict = game.verdict()
    expect(verdict.terminalReason).toBe('completed')
    expect(verdict.refereeConsistent).toBe(true)
    expect(verdict.outcome).toMatchObject({ completed: true, acceptedPrefix: 3, target: 3 })
    expect(verdict.metrics.participationEntropy).toBeGreaterThan(0)
    // No relay after the terminal acceptance — the loop must halt.
    const wave = game.nextDeliveries()
    expect(wave.platformEvents).toHaveLength(0)
  })

  it('terminates as step_limit / stalled without claiming completion', () => {
    const { game } = fixture(5)
    game.nextDeliveries()
    game.terminate('step_limit')
    expect(game.isTerminal()).toBe(true)
    expect(game.verdict().terminalReason).toBe('step_limit')
    expect(game.verdict().outcome).toMatchObject({ completed: false, acceptedPrefix: 0 })
  })
})
