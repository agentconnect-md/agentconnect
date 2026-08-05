import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionContext } from '../../packages/daemon/src/mcp/ops.js'
import { runWerewolf, werewolfDmRoomAlias, werewolfManifest } from '../games/engine.js'
import { compileTopology } from '../games/topology.js'
import { WerewolfGame, assignWerewolfRoles } from '../games/werewolf.js'
import { ArenaWorld } from '../games/world.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-werewolf-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

function fixture(seed = 21) {
  const topology = compileTopology(werewolfManifest({ seed }))
  const world = new ArenaWorld(topology)
  const game = new WerewolfGame({
    world,
    publicRoomAlias: 'village-square',
    wolfDenAlias: 'wolf-den',
    dmRoomAliasFor: werewolfDmRoomAlias
  })
  const aliases = topology.agents.map((agent) => agent.alias)
  const byRole = (role: string) => aliases.filter((alias) => game.roleOf(alias) === role)
  const agentIdOf = (alias: string) => topology.agents.find((agent) => agent.alias === alias)!.agentId
  const tool = (name: string) => game.environment.tools!.find((def) => def.descriptor.name === name)!
  const call = (name: string, alias: string, target: string) =>
    tool(name).handler({
      runId: 'test-run',
      agentId: agentIdOf(alias),
      sessionContext: {} as SessionContext,
      input: { target }
    }) as Promise<{ disposition: string; reason?: string }>
  /** Drain the day-open wave, then let the drained cascade close the discussion
   *  and open the structured vote — the same two calls the runner makes. */
  const openVote = () => {
    game.nextDeliveries()
    game.nextDeliveries()
  }
  return { topology, world, game, aliases, byRole, agentIdOf, tool, call, openVote }
}

/** Read one run's `world-events.jsonl` back as records. */
function worldEvents(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

interface DayRecord {
  round: number
  order: string[]
  spoke: string[]
  neverSpoke: string[]
  outOfOrder: string[]
  reachedIndex: number
  outcome: 'order_complete' | 'stalled'
  stalledAfter?: string
  loopGuardTripped: string[]
  reachedVote: boolean
}

describe('werewolf evaluation tools (§6) — structured actions, never prose', () => {
  it('assigns roles deterministically per seed and builds the wolf den from them', () => {
    const a = assignWerewolfRoles(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 5)
    const b = assignWerewolfRoles(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 5)
    const c = assignWerewolfRoles(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 6)
    expect([...a.entries()]).toEqual([...b.entries()])
    expect([...a.values()].filter((role) => role === 'werewolf')).toHaveLength(2)
    expect([...a.entries()]).not.toEqual([...c.entries()])
    // The table scales — two wolves, one seer, one doctor, villagers for the rest.
    const wide = assignWerewolfRoles(
      Array.from({ length: 12 }, (_, index) => `p${index + 1}`),
      5
    )
    expect([...wide.values()].filter((role) => role === 'werewolf')).toHaveLength(2)
    expect([...wide.values()].filter((role) => role === 'villager')).toHaveLength(8)
    const f = fixture()
    const den = f.topology.rooms.find((room) => room.alias === 'wolf-den')!
    expect(den.memberAgentIds.map((id) => f.game.roleOf(f.world.aliasOfAgent(id)))).toEqual(['werewolf', 'werewolf'])
    expect(den.isPrivate).toBe(true)
  })

  it('scopes tool visibility by role and rejects wrong-role or wrong-phase calls in the handler', async () => {
    const f = fixture()
    const [wolf] = f.byRole('werewolf')
    const [seer] = f.byRole('seer')
    const [villager] = f.byRole('villager')
    expect(f.tool('kill').visibleTo(f.agentIdOf(wolf!))).toBe(true)
    expect(f.tool('kill').visibleTo(f.agentIdOf(villager!))).toBe(false)
    expect(f.tool('inspect').visibleTo(f.agentIdOf(seer!))).toBe(true)
    expect(f.tool('vote').visibleTo(f.agentIdOf(villager!))).toBe(true)
    // Setup phase: no night action is legal yet.
    await expect(f.call('kill', wolf!, villager!)).resolves.toMatchObject({
      disposition: 'rejected',
      reason: 'wrong_phase'
    })
    f.game.nextDeliveries() // setup → queues night 1
    f.game.nextDeliveries() // night 1 delivered
    // The daemon guarantees identity; the game rejects a villager's kill.
    await expect(f.call('kill', villager!, wolf!)).resolves.toMatchObject({
      disposition: 'rejected',
      reason: 'wrong_role'
    })
  })

  it('is idempotent per (round, action): the second kill reports duplicate, never double-applies', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const villagers = f.byRole('villager')
    await expect(f.call('kill', wolves[0]!, villagers[0]!)).resolves.toMatchObject({ disposition: 'accepted' })
    await expect(f.call('kill', wolves[1]!, villagers[1]!)).resolves.toMatchObject({
      disposition: 'duplicate',
      reason: 'kill_already_chosen'
    })
  })

  it('refuses a vote while the sequential discussion is still running', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const villagers = f.byRole('villager')
    await f.call('kill', wolves[0]!, villagers[0]!)
    f.game.applyEffects([]) // night resolves → DAY n, discussion stage
    await expect(f.call('vote', villagers[1]!, wolves[0]!)).resolves.toMatchObject({
      disposition: 'rejected',
      reason: 'discussion_in_progress'
    })
    // Only once the drained discussion hands the day to the referee's VOTE call.
    f.openVote()
    await expect(f.call('vote', villagers[1]!, wolves[0]!)).resolves.toMatchObject({ disposition: 'accepted' })
  })

  it('rejects a dead player structurally and resolves votes by plurality with earliest-vote ties', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const [seer] = f.byRole('seer')
    const [doctor] = f.byRole('doctor')
    const villagers = f.byRole('villager')
    // Night 1: wolves kill villager-0, doctor protects someone else, seer inspects a wolf.
    await f.call('kill', wolves[0]!, villagers[0]!)
    await f.call('protect', doctor!, villagers[1]!)
    await f.call('inspect', seer!, wolves[0]!)
    f.game.applyEffects([])
    f.openVote()
    // Day 1: the victim is dead — their vote is a structured rejection.
    await expect(f.call('vote', villagers[0]!, wolves[0]!)).resolves.toMatchObject({
      disposition: 'rejected',
      reason: 'dead_player'
    })
    // Everyone living votes the inspected wolf except the wolves.
    for (const alias of [seer!, doctor!, villagers[1]!, villagers[2]!]) {
      await expect(f.call('vote', alias, wolves[0]!)).resolves.toMatchObject({ disposition: 'accepted' })
    }
    await f.call('vote', wolves[0]!, seer!)
    await f.call('vote', wolves[1]!, seer!)
    f.game.applyEffects([])
    expect(f.game.roleOf(wolves[0]!)).toBe('werewolf')
    const verdict = f.game.verdict()
    expect((verdict.outcome.survivors as string[]).includes(wolves[0]!)).toBe(false)
    expect(verdict.metrics.rejectedActions).toBeGreaterThanOrEqual(1)
  })

  it('counts a private-role canary in public speech as a privateLeaks violation', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    const { wolf } = f.game.canaries()
    const publicRoom = f.topology.rooms.find((room) => room.alias === 'village-square')!
    const [wolfAlias] = f.byRole('werewolf')
    const integration = f.topology.integrations.find((i) => i.agentAlias === wolfAlias)!
    await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: integration.integrationId,
      channel: publicRoom.channel,
      thread: publicRoom.thread,
      identity: { agentAuthorId: integration.agentId },
      text: `my secret is ${wolf}`
    })
    f.game.applyEffects(f.game.drainOutboundEffects())
    expect(f.game.verdict().invariants.privateLeaks).toBe(1)
    // The same canary in the wolf den is NOT a leak — that room is private to wolves.
    const den = f.topology.rooms.find((room) => room.alias === 'wolf-den')!
    await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: integration.integrationId,
      channel: den.channel,
      thread: den.thread,
      identity: { agentAuthorId: integration.agentId },
      text: `between us: ${wolf}`
    })
    f.game.applyEffects(f.game.drainOutboundEffects())
    expect(f.game.verdict().invariants.privateLeaks).toBe(1)
  })
})

describe('werewolf end to end — scripted role-followers over real sessions and §6 tools', () => {
  it('plays a full seeded game through the daemon: private roles, real tool actions, a winner, zero leaks', async () => {
    const artifactDir = join(scratch(), 'run')
    const result = await runWerewolf({ seed: 42, artifactDir, timeoutMs: 240_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.refereeConsistent).toBe(true)
    expect(['village', 'werewolves']).toContain(result.verdict.outcome.winner)
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })
    expect(result.verdict.metrics.kills).toBeGreaterThanOrEqual(1)
    expect(result.verdict.metrics.votesCast).toBeGreaterThanOrEqual(5)
    expect(result.verdict.metrics.inspections).toBeGreaterThanOrEqual(1)
    const events = worldEvents(result.paths.worldEvents)
    // Structured actions came through the §6 registry with dispositions.
    expect(events.some((event) => event.type === 'action.kill' && event.disposition === 'accepted')).toBe(true)
    expect(events.some((event) => event.type === 'action.vote' && event.disposition === 'accepted')).toBe(true)
    // Private referee deliveries are logged WITHOUT their private text.
    const privates = events.filter((event) => event.type === 'referee.private_event')
    expect(privates.length).toBeGreaterThanOrEqual(7)
    for (const event of privates) expect(event.text).toBeUndefined()
    // And no canary string appears anywhere in the public artifact record of
    // delivered public-room speech.
    const gameResult = JSON.parse(readFileSync(result.paths.gameResult, 'utf8'))
    expect(gameResult.invariants.privateLeaks).toBe(0)
    expect(gameResult.outcome.winner).toBe(result.verdict.outcome.winner)
  }, 300_000)

  it('same seed, same roles, same winner (environment-deterministic, §8.1)', async () => {
    const first = await runWerewolf({ seed: 9, artifactDir: join(scratch(), 'a'), timeoutMs: 240_000 })
    const second = await runWerewolf({ seed: 9, artifactDir: join(scratch(), 'b'), timeoutMs: 240_000 })
    expect(first.status).toBe('passed')
    expect(second.status).toBe('passed')
    expect(first.verdict.outcome.roles).toEqual(second.verdict.outcome.roles)
    expect(first.verdict.outcome.winner).toBe(second.verdict.outcome.winner)
  }, 600_000)
})

describe('werewolf day phase — natural sequential discussion driven by peer messages', () => {
  it('opens the day once and then advances only on players continuing each other', async () => {
    const artifactDir = join(scratch(), 'sequential')
    const result = await runWerewolf({ seed: 42, artifactDir, timeoutMs: 240_000 })
    expect(result.status).toBe('passed')
    const days = result.verdict.outcome.dayDiscussions as DayRecord[]
    expect(days.length).toBeGreaterThanOrEqual(1)

    // Every speech landed on the announced order, exactly once each, in order.
    for (const day of days) {
      expect(day.outcome).toBe('order_complete')
      expect(day.spoke).toEqual(day.order)
      expect(day.neverSpoke).toEqual([])
      expect(day.outOfOrder).toEqual([])
      expect(day.reachedVote).toBe(true)
    }
    expect(result.verdict.metrics.speechesDelivered).toBe(result.verdict.metrics.speakingTurnsOwed)

    const events = worldEvents(result.paths.worldEvents)
    const publicRoom = 'village-square'
    // ── the referee opens the day and then SHUTS UP ──
    // Between opening a day and closing it, the only referee room event is the
    // single DAY prompt. Nobody is called on; nothing re-seeds the round.
    for (let index = 0; index < events.length; index++) {
      if (events[index]!.type !== 'day.discussion_opened') continue
      const end = events.findIndex((event, at) => at > index && event.type === 'day.discussion_closed')
      expect(end).toBeGreaterThan(index)
      const refereeSpeech = events
        .slice(index, end)
        .filter((event) => event.type === 'referee.room_event' && event.roomId === publicRoom)
      expect(refereeSpeech).toHaveLength(1)
      expect(String(refereeSpeech[0]!.text)).toMatch(/^DAY \d+\./)
      // …and each later speaker was woken by the PREVIOUS speaker's echoed post:
      // between speech k landing and speech k+1 landing, the only thing that
      // entered the daemon on the public room was speech k's own echo.
      const speeches = events.slice(index, end).filter((event) => event.type === 'day.speech')
      expect(speeches.length).toBeGreaterThanOrEqual(2)
      for (let step = 1; step < speeches.length; step++) {
        const previous = speeches[step - 1]!
        const current = speeches[step]!
        const wake = events.find(
          (event) =>
            event.type === 'platform.echo' &&
            event.fromAlias === previous.agentAlias &&
            Number(event.sequence) > Number(previous.effectSequence) &&
            Number(event.sequence) < Number(current.effectSequence)
        )
        expect(wake, `speech ${step} was not preceded by an echo of ${String(previous.agentAlias)}`).toBeDefined()
        // Nothing the referee said could have prompted it.
        const refereeBetween = events.filter(
          (event) =>
            (event.type === 'referee.room_event' || event.type === 'referee.private_event') &&
            Number(event.sequence) > Number(previous.effectSequence) &&
            Number(event.sequence) < Number(current.effectSequence)
        )
        expect(refereeBetween).toEqual([])
      }
    }
    // The echo really is the transport: one admitted peer wake per speech per
    // OTHER room member. Nothing here is a referee delivery.
    const members = (result.verdict.outcome.roles as Record<string, string>) ?? {}
    const memberCount = Object.keys(members).length
    expect(result.verdict.metrics.peerWakesAdmitted).toBe(
      Number(result.verdict.metrics.speechesDelivered) * (memberCount - 1)
    )
  }, 300_000)

  it('a seven-player table stays inside the automatic-turn budget because each day is re-opened by the referee', async () => {
    const result = await runWerewolf({ seed: 42, artifactDir: join(scratch(), 'budget'), timeoutMs: 240_000 })
    const wakes = result.verdict.outcome.peerWakes as Record<
      string,
      { admitted: number; gated: number; suppressed: number }
    >
    // Nobody was ever refused, and the discussion never latched a circuit…
    expect(result.verdict.metrics.peerWakesGated).toBe(0)
    expect(result.verdict.outcome.loopGuardLatched).toEqual([])
    // …even though several players absorbed MORE than the 8 automatic turns a
    // 60s window allows. That can only happen because the referee's DAY/VOTE
    // broadcasts are trusted HUMAN turns, and a human turn resets the automatic
    // counter (`recordLoopGuardTurn`). The budget is therefore per ROUND of
    // discussion, not per game.
    const busiest = Math.max(...Object.values(wakes).map((entry) => entry.admitted))
    expect(busiest).toBeGreaterThan(8)
    // Per round, no player is charged more than (order length - 1).
    const days = result.verdict.outcome.dayDiscussions as DayRecord[]
    for (const day of days) expect(day.order.length - 1).toBeLessThanOrEqual(8)
  }, 300_000)

  it('a long speaking order dies exactly at the automatic-turn budget, and the day still reaches the vote', async () => {
    // Twelve seats. Day 1 has eleven living players, so the order is longer than
    // any player's automatic-turn budget can carry.
    const result = await runWerewolf({
      seed: 42,
      playerCount: 12,
      artifactDir: join(scratch(), 'long-order'),
      maxSteps: 120,
      timeoutMs: 600_000
    })
    expect(result.status).toBe('passed')
    const days = result.verdict.outcome.dayDiscussions as DayRecord[]
    const first = days[0]!
    expect(first.order.length).toBeGreaterThan(9)
    // Speaker at index i must absorb i automatic wakes before its turn arrives,
    // and MAX_AUTOMATIC_TURNS_PER_WINDOW is 8 — so index 8 (the ninth speaker)
    // is the last one the budget can carry, and index 9 is refused.
    expect(first.spoke).toHaveLength(9)
    expect(first.spoke).toEqual(first.order.slice(0, 9))
    expect(first.outcome).toBe('stalled')
    expect(first.stalledAfter).toBe(first.order[8])
    expect(first.neverSpoke).toEqual(first.order.slice(9))
    expect(first.loopGuardTripped.length).toBeGreaterThanOrEqual(1)

    // The refusal is the loop guard, and its arithmetic is exact: every latched
    // player absorbed exactly 8 automatic turns and was gated after that.
    const wakes = result.verdict.outcome.peerWakes as Record<
      string,
      { admitted: number; gated: number; suppressed: number }
    >
    const latched = result.verdict.outcome.loopGuardLatched as string[]
    expect(latched.length).toBeGreaterThanOrEqual(1)
    for (const alias of latched) {
      expect(wakes[alias]!.admitted).toBe(8)
      expect(wakes[alias]!.gated).toBeGreaterThan(0)
    }
    expect(result.verdict.metrics.peerWakesGated).toBeGreaterThan(0)

    // The latch is DURABLE (only `!resume` clears it, and no one sends one), so
    // the same players are still missing on the next day…
    expect(days.length).toBeGreaterThanOrEqual(2)
    for (const day of days) {
      expect(day.reachedVote).toBe(true)
      for (const alias of latched) expect(day.spoke).not.toContain(alias)
    }
    // …and they cannot even be reached by the referee's VOTE broadcast, so the
    // day reaches the vote with fewer ballots than living players.
    expect(result.verdict.metrics.incompleteVotes).toBeGreaterThanOrEqual(1)
    expect(result.verdict.metrics.daysReachingVote).toBe(result.verdict.metrics.daysOpened)
    expect(result.verdict.metrics.daysCompletingTheOrder).toBe(0)
    // A day that died mid-order is still a clean trial: no invariant was touched.
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })
  }, 600_000)
})
