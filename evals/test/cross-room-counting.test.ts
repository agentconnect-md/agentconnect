import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { crossRoomManifest, runCrossRoomCounting } from '../games/engine.js'
import { CrossRoomCountingGame, sendMessageOrder } from '../games/cross-room-counting.js'
import { compileTopology } from '../games/topology.js'
import { ArenaWorld } from '../games/world.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-cross-room-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

function refereeFixture(options: { boundary?: number; target?: number } = {}) {
  const topology = compileTopology(crossRoomManifest({ seed: 13 }))
  const world = new ArenaWorld(topology)
  const game = new CrossRoomCountingGame({
    world,
    originRoomAlias: 'discord-origin',
    destinationRoomAlias: 'slack-support',
    bridgeAlias: 'bridge-x',
    boundary: options.boundary ?? 2,
    target: options.target ?? 4
  })
  const origin = topology.rooms.find((room) => room.alias === 'discord-origin')!
  const destination = topology.rooms.find((room) => room.alias === 'slack-support')!
  const integrationOf = (alias: string, platform: string) =>
    topology.integrations.find((i) => i.agentAlias === alias && i.platform === platform)!
  // `thread` semantics: omitted ⇒ the room thread; null ⇒ a channel-ROOT post.
  const reply = async (alias: string, room: typeof origin, text: string, thread?: string | null) => {
    const integration = integrationOf(alias, room.platform)
    const resolvedThread = thread === null ? undefined : (thread ?? room.thread)
    return world.recordOutbound({
      kind: 'reply',
      platform: room.platform as 'slack' | 'discord',
      integrationId: integration.integrationId,
      channel: room.channel,
      ...(resolvedThread !== undefined ? { thread: resolvedThread } : {}),
      identity: { agentAuthorId: integration.agentId },
      text
    })
  }
  return { topology, world, game, origin, destination, integrationOf, reply }
}

describe('cross-room counting referee (§10.2)', () => {
  it('issues a fully-addressed handoff order at the boundary and relays only after the actual delivered send', async () => {
    const f = refereeFixture()
    f.game.nextDeliveries() // start broadcast (origin room)
    await f.reply('agent-a', f.origin, '1')
    await f.reply('agent-b', f.origin, '2')
    f.game.applyEffects(f.game.drainOutboundEffects())
    // Origin relay for 1 accepted, then the handoff order for the boundary.
    const relay1 = f.game.nextDeliveries()
    expect(relay1.platformEvents[0]!.payload.text).toContain('Accepted: 1')
    const order = f.game.nextDeliveries()
    const orderText = order.platformEvents[0]!.payload.text
    expect(order.platformEvents).toHaveLength(f.origin.memberIntegrationIds.length)
    expect(orderText).toContain('ORDER assignee=bridge-x')
    expect(orderText).toContain(`platform=${f.destination.platform}`)
    expect(orderText).toContain(`channel=${f.destination.channel}`)
    expect(orderText).toContain(`thread=${f.destination.thread}`)
    // No destination relay yet — the referee never secretly moves the task.
    expect(f.game.nextDeliveries().platformEvents).toHaveLength(0)
    // Bridge delivers the real cross-room send → destination continuation.
    await f.reply('bridge-x', f.destination, 'HANDOFF baton: continue counting at 3')
    f.game.applyEffects(f.game.drainOutboundEffects())
    const continuation = f.game.nextDeliveries()
    expect(continuation.platformEvents).toHaveLength(f.destination.memberIntegrationIds.length)
    expect(continuation.platformEvents[0]!.payload.channel).toBe(f.destination.channel)
    expect(continuation.platformEvents[0]!.payload.text).toContain('Next expected number: 3')
    const verdict = f.game.verdict()
    expect(verdict.outcome).toMatchObject({ handoffDelivered: true, handoffCorrect: true })
    expect(verdict.metrics.payloadComplete).toBe(1)
  })

  it('scores a channel-root handoff as delivered but incorrect (§10.2 full addressing)', async () => {
    const f = refereeFixture()
    f.game.nextDeliveries()
    await f.reply('agent-a', f.origin, '1')
    await f.reply('agent-b', f.origin, '2')
    f.game.applyEffects(f.game.drainOutboundEffects())
    // Channel-root send: no thread — starts a different conversation.
    await f.reply('bridge-x', f.destination, 'HANDOFF baton: continue counting at 3', null)
    f.game.applyEffects(f.game.drainOutboundEffects())
    const verdict = f.game.verdict()
    expect(verdict.metrics).toMatchObject({ handoffAttempts: 1, handoffDelivered: 1, handoffCorrect: 0 })
    expect(verdict.outcome).toMatchObject({ handoffCorrect: false, completed: false })
  })

  it('fails the canary invariant when origin-private context reaches the destination room', async () => {
    const f = refereeFixture()
    const start = f.game.nextDeliveries()
    const canary = /referee-private canary: (\S+) —/.exec(start.platformEvents[0]!.payload.text)![1]!
    await f.reply('agent-a', f.origin, '1')
    await f.reply('agent-b', f.origin, '2')
    f.game.applyEffects(f.game.drainOutboundEffects())
    await f.reply('bridge-x', f.destination, `HANDOFF baton: continue counting at 3 (${canary})`)
    f.game.applyEffects(f.game.drainOutboundEffects())
    const verdict = f.game.verdict()
    expect(verdict.invariants.privateLeaks).toBe(1)
  })

  it('completes only after the bridge reports back to the origin conversation', async () => {
    const f = refereeFixture()
    f.game.nextDeliveries()
    await f.reply('agent-a', f.origin, '1')
    await f.reply('agent-b', f.origin, '2')
    f.game.applyEffects(f.game.drainOutboundEffects())
    await f.reply('bridge-x', f.destination, 'HANDOFF baton: continue counting at 3')
    f.game.applyEffects(f.game.drainOutboundEffects())
    await f.reply('agent-c', f.destination, '3')
    await f.reply('agent-d', f.destination, '4')
    f.game.applyEffects(f.game.drainOutboundEffects())
    expect(f.game.isTerminal()).toBe(false)
    expect(f.game.verdict().outcome).toMatchObject({ acceptedPrefix: 4, completionReported: false })
    await f.reply('bridge-x', f.origin, 'COMPLETE: counted to 4')
    f.game.applyEffects(f.game.drainOutboundEffects())
    expect(f.game.isTerminal()).toBe(true)
    const verdict = f.game.verdict()
    expect(verdict.terminalReason).toBe('completed')
    expect(verdict.refereeConsistent).toBe(true)
    expect(verdict.outcome).toMatchObject({ completed: true, completionReported: true })
  })

  it('formats orders with explicit coordinates', () => {
    const text = sendMessageOrder({
      assignee: 'bridge-x',
      platform: 'slack',
      integrationId: 'int-1',
      channel: 'C1',
      thread: 'T1',
      message: 'HANDOFF baton'
    })
    expect(text).toContain('platform=slack integrationId=int-1 channel=C1 thread=T1')
  })
})

/**
 * §14 step 5 measured against the LANDED `sendMessage`.
 *
 * §10.2 requires the cross-room handoff to be FULLY addressed — explicit
 * platform, integrationId, channel AND thread — and scores a channel-root send
 * as an incorrect handoff, because the destination conversation is a thread
 * (`S-GAME-001`) and a root post starts a different one.
 *
 * The routing rework (#503) removed `thread` from EVERY `sendMessage` target:
 * `packages/daemon/src/mcp/ops.ts` (§2.2) states that a visible send is either
 * a direct message or a channel-ROOT post, and `assertOnlyKeys` rejects a
 * supplied `thread` loudly rather than silently posting at the root. Addressing
 * the CURRENT thread is the ordinary turn reply's job.
 *
 * So the §10.2 handoff is no longer expressible against a threaded destination:
 * the only send the product accepts is exactly the one §10.2 scores as
 * incorrect. This test pins that boundary as a MEASUREMENT — the origin segment
 * plays out fully and the game stalls at the handoff, on the product's refusal,
 * with the bridge's own turn carrying the reason. It is deliberately not an
 * expected-fail: nothing here is broken, the milestone is blocked on a product
 * capability that does not exist.
 */
describe('cross-room counting end to end — the §10.2 handoff against the landed sendMessage', () => {
  it('counts the origin segment, then stalls because a fully-addressed handoff is refused (#503 §2.2)', async () => {
    const artifactDir = join(scratch(), 'run')
    const result = await runCrossRoomCounting({ seed: 42, boundary: 6, target: 12, artifactDir, timeoutMs: 150_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    // The origin room plays its whole segment through the real routing path.
    expect(result.verdict.refereeConsistent).toBe(true)
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })
    expect(result.verdict.outcome).toMatchObject({
      completed: false,
      acceptedPrefix: 6,
      target: 12,
      boundary: 6,
      // No handoff is possible, so none is attempted-and-delivered.
      handoffDelivered: false,
      completionReported: false
    })
    // The conversation ends at the boundary, not at a routing limit.
    expect(result.verdict.terminalReason).toBe('stalled')

    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Every accepted number belongs to the origin room; the destination room
    // never learns of the game, because the referee never secretly moves it.
    const acceptedRooms = worldEvents
      .filter((event) => event.type === 'count.candidate' && event.accepted)
      .map((event) => event.roomId)
    expect(acceptedRooms).toEqual(Array(6).fill('discord-origin'))
    expect(worldEvents.find((event) => event.type === 'handoff')).toBeUndefined()
    expect(worldEvents.find((event) => event.type === 'completion_report')).toBeUndefined()

    // The refusal is the product's, surfaced through the bridge's own turn: the
    // order carried `thread`, and the channel target does not accept it.
    const order = worldEvents.find(
      (event) => event.type === 'referee.room_event' && String(event.text).includes('ORDER assignee=bridge-x')
    )
    expect(String(order.text)).toContain('thread=')
    const refusal = worldEvents.find(
      (event) => event.type === 'outbound.delivered' && String(event.text).startsWith('order failed:')
    )
    expect(refusal.agentAlias).toBe('bridge-x')
    expect(String(refusal.text)).toContain('channel target allows only')
    expect(String(refusal.text)).toContain('unexpected `thread`')
  }, 180_000)
})
