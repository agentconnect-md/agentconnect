import { describe, expect, it } from 'vitest'
import { CountingGame, type CountingVariant } from '../games/counting.js'
import { countingManifest } from '../games/engine.js'
import { compileTopology } from '../games/topology.js'
import { ArenaWorld } from '../games/world.js'

const AGENTS = ['agent-a', 'agent-b', 'agent-c', 'agent-d']

function fixture(target = 3, variant: CountingVariant = 'referee-announced') {
  const topology = compileTopology(countingManifest({ seed: 9, agents: AGENTS }))
  const world = new ArenaWorld(topology)
  const game = new CountingGame({ world, roomAlias: 'counting-room', target, variant })
  // Peer relays are injected LIVE from the §7.2 sink (production timing), so
  // the fixture captures them through the runner's live-ingress port.
  const injected: { integrationId: string; payload: Record<string, any> }[] = []
  game.attachLiveIngress((event) => {
    injected.push(event as never)
    return {
      admission: Promise.resolve({ admitted: false, reason: 'gated' }),
      completion: Promise.resolve({ status: 'not_admitted' })
    } as never
  })
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
  return { topology, world, game, room, reply, integrationOf, injected }
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
    expect(verdict.outcome.contributionOrder).toEqual(['agent-a', 'agent-c'])
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
    expect(verdict.outcome.contributionOrder).toEqual(['agent-a', 'agent-d'])
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

describe('peer-driven counting (§3.3) — agents continue the count from EACH OTHER', () => {
  it('opens with peer rules and a silent-referee contract', () => {
    const { game, room } = fixture(3, 'peer-driven')
    const start = game.nextDeliveries()
    expect(start.platformEvents).toHaveLength(4)
    const text = start.platformEvents[0]!.payload.text
    expect(text).toContain('by continuing each other')
    expect(text).toContain('referee stays silent')
    expect(text).not.toContain('Next expected number')
    expect(start.platformEvents[0]!.payload.channel).toBe(room.channel)
  })

  it("echoes a delivered reply LIVE under the poster's REAL managed bot identity and ORIGINAL coordinates", async () => {
    const { game, reply, room, integrationOf, world, injected } = fixture(3, 'peer-driven')
    game.nextDeliveries()
    // The echo fires from the §7.2 sink itself — before any wave barrier and
    // before applyEffects, so a concurrent turn can still observe it.
    const posted = await reply('agent-a', '1')
    expect(posted.status).toBe('delivered')
    expect(injected).toHaveLength(3)
    expect(new Set(injected.map((event) => event.payload.messageId)).size).toBe(1)
    // The STREAMING copy keeps the post's own channel:ts — the same event every
    // other dedicated app receives — never a synthetic re-mint.
    expect(injected[0]!.payload.messageId).toBe((posted as { messageId: string }).messageId)
    expect(injected.map((event) => event.integrationId)).not.toContain(integrationOf('agent-a').integrationId)
    for (const event of injected) {
      expect(event.payload.thread).toBe(room.thread)
      // ORIGINAL text — no synthetic wrapper — and the SAME managed bot
      // identity production Slack would deliver. A streaming copy carries no
      // authorship claim, so ingress suppresses it (final events only).
      expect(event.payload.text).toBe('1')
      expect(event.payload.sender.id).toBe(integrationOf('agent-a').botUserId)
      expect(event.payload.sender.isBot).toBe(true)
      expect(event.payload.agentAuthorship).toBeUndefined()
    }
    // The provider thread history carries the post under its real bot identity
    // with the stable author id — this is what the turn-final snapshot reads.
    const history = world.threadHistory(room.channel, room.thread)
    const post = history.find((message) => message.text === '1')
    expect(post).toMatchObject({ isBot: true, agentAuthorId: integrationOf('agent-a').agentId })
    game.applyEffects(game.drainOutboundEffects())
    const events = world.events()
    expect(events.filter((event) => event.type === 'referee.room_event')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'platform.echo')).toHaveLength(1)
    // Echoes never come back through the wave barrier.
    expect(game.nextDeliveries().platformEvents).toHaveLength(0)
  })

  it('echoes a FINALIZED response as the response-final tagged event carrying the daemon-stamped §4 claim', async () => {
    const { game, reply, room, integrationOf, world, injected } = fixture(3, 'peer-driven')
    game.nextDeliveries()
    const posted = (await reply('agent-a', '1')) as { status: string; messageId: string }
    injected.length = 0
    const integration = integrationOf('agent-a')
    await world.recordOutbound({
      kind: 'finalize',
      platform: 'slack',
      integrationId: integration.integrationId,
      channel: room.channel,
      thread: room.thread,
      messageTs: posted.messageId,
      identity: { agentAuthorId: integration.agentId },
      text: '1',
      response: { responseId: 'resp-1', deliveryState: 'final', hopCount: 0, mentionedAgentIds: [] }
    })
    // The finalized message_changed echo keeps the ORIGINAL coordinates —
    // msgId included — and is told apart from the post it edits by
    // `ingressEventTag` (the extra per-connection dedup dimension), carrying
    // the author's §4 claim for the receiving daemon to verify.
    expect(injected).toHaveLength(3)
    for (const event of injected) {
      expect(event.payload.messageId).toBe(posted.messageId)
      expect(event.payload.ingressEventTag).toBe('response-final')
      expect(event.payload.thread).toBe(room.thread)
      expect(event.payload.sender.id).toBe(integration.botUserId)
      expect(event.payload.agentAuthorship).toMatchObject({
        authorAgentId: integration.agentId,
        responseId: 'resp-1',
        deliveryState: 'final',
        hopCount: 0,
        mentionedAgentIds: []
      })
    }
  })

  it('echoes duplicates, wrong numbers, AND chatter alike — production echoes every delivered post', async () => {
    const { game, reply, injected } = fixture(3, 'peer-driven')
    game.nextDeliveries()
    await reply('agent-a', '1')
    await reply('agent-b', '1') // duplicate race — still a real room message
    await reply('agent-c', '5') // wrong number — still a real room message
    await reply('agent-d', 'waiting.') // chatter — a real room message too
    // Four delivered replies × three other members each. Since PR #549 even a
    // digit-free reply CONTINUES the conversation if it finalizes with a
    // verifiable claim, so the echo must not editorialize about content.
    expect(injected).toHaveLength(12)
    expect(injected.filter((event) => String(event.payload.text).includes('waiting.'))).toHaveLength(3)
    game.applyEffects(game.drainOutboundEffects())
    const verdict = game.verdict()
    expect(verdict.outcome).toMatchObject({ acceptedPrefix: 1, variant: 'peer-driven' })
    expect(verdict.metrics.noiseReplies).toBe(1)
  })

  it('treats a post-completion acknowledgment as termination awareness, never noise', async () => {
    const { game, reply } = fixture(2, 'peer-driven')
    game.nextDeliveries()
    await reply('agent-a', '1')
    await reply('agent-b', '2')
    game.applyEffects(game.drainOutboundEffects())
    expect(game.isTerminal()).toBe(true)
    // The group recognizing completion on its own is a POSITIVE signal.
    await reply('agent-c', '2 has already been posted, so the count is complete.')
    await reply('agent-d', 'we are done here.')
    game.applyEffects(game.drainOutboundEffects())
    const verdict = game.verdict()
    expect(verdict.metrics.terminationAcknowledgments).toBe(2)
    expect(verdict.metrics.noiseReplies).toBe(0)
    // Neither acknowledgment is counted as a candidate or a collision.
    expect(verdict.metrics.candidates).toBe(2)
    expect(verdict.metrics.collisions).toBe(0)
    // The collaboration report carries the group turn-taking record.
    expect(verdict.outcome.contributions).toEqual({ 'agent-a': 1, 'agent-b': 1, 'agent-c': 0, 'agent-d': 0 })
  })

  it('records a consecutive contribution as a turn-taking-balance observation, never a violation', async () => {
    const { game, reply } = fixture(3, 'peer-driven')
    game.nextDeliveries()
    await reply('agent-a', '1')
    game.applyEffects(game.drainOutboundEffects())
    // A hidden rejection would diverge the official count from what the room
    // can see — with a silent referee the consecutive contribution COUNTS,
    // and the turn-taking miss is a coordination-quality observation.
    await reply('agent-a', '2')
    game.applyEffects(game.drainOutboundEffects())
    await reply('agent-c', '3')
    game.applyEffects(game.drainOutboundEffects())
    expect(game.isTerminal()).toBe(true)
    const verdict = game.verdict()
    expect(verdict.terminalReason).toBe('completed')
    expect(verdict.refereeConsistent).toBe(true)
    expect(verdict.outcome).toMatchObject({
      completed: true,
      acceptedPrefix: 3,
      contributionOrder: ['agent-a', 'agent-a', 'agent-c']
    })
    expect(verdict.metrics.consecutiveContributions).toBe(1)
    expect(verdict.metrics.consecutiveScorerRejections).toBe(0)
    // Terminal: the final number is not relayed and the loop halts.
    expect(game.nextDeliveries().platformEvents).toHaveLength(0)
  })
})
