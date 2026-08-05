import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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
  const roomOf = (roomAlias: string) => topology.rooms.find((room) => room.alias === roomAlias)!
  const integrationOf = (alias: string) => topology.integrations.find((i) => i.agentAlias === alias)!
  /** `alias` says `text` in one of its conversations, exactly as a delivered
   *  agent reply — then the world reads the round's effects, as the runner does. */
  const post = async (alias: string, where: 'room' | 'den' | 'dm', text: string) => {
    const room = roomOf(where === 'room' ? 'village-square' : where === 'den' ? 'wolf-den' : werewolfDmRoomAlias(alias))
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
  const apply = () => game.applyEffects(game.drainOutboundEffects())
  const say = async (alias: string, where: 'room' | 'den' | 'dm', text: string) => {
    const result = await post(alias, where, text)
    apply()
    return result
  }
  /** The last disposition recorded for `alias` + `action`, from the world log. */
  const lastAction = (alias: string, action: string) =>
    [...world.events()].reverse().find((e) => e.type === `action.${action}` && e.agentAlias === alias) as
      { disposition: string; reason?: string; target?: string } | undefined
  /** Drain the day-open wave, then let the drained cascade close the discussion
   *  and open the structured vote — the same two calls the runner makes. */
  const openVote = () => {
    game.nextDeliveries()
    game.nextDeliveries()
  }
  return {
    topology,
    world,
    game,
    aliases,
    byRole,
    agentIdOf,
    post,
    apply,
    say,
    lastAction,
    roomOf,
    integrationOf,
    openVote
  }
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

describe('werewolf actions are MESSAGES, parsed from the conversation they belong to', () => {
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

  it('reads an action only in its own conversation, and only from the right role and phase', async () => {
    const f = fixture()
    const [wolf] = f.byRole('werewolf')
    const [villager] = f.byRole('villager')
    // Before the night opens, the den is not an action conversation: the same
    // sentence states nothing, and nothing is recorded against anyone.
    await f.say(wolf!, 'den', `we kill ${villager!} tonight.`)
    expect(f.lastAction(wolf!, 'kill')).toBeUndefined()
    f.game.nextDeliveries() // setup → queues night 1
    f.game.nextDeliveries() // night 1 delivered
    // A non-wolf cannot even PUT a message in the den: role visibility is room
    // membership now, enforced by the world's §7.2 authorization, not by a tool
    // privacy predicate. This is the property the message design buys.
    const intrusion = (await f.post(villager!, 'den', `we kill ${wolf!} tonight.`)) as {
      status: string
      reason?: string
    }
    expect(intrusion.status).toBe('rejected')
    expect(['not_a_member', 'channel_not_visible']).toContain(intrusion.reason)
    f.apply()
    expect(f.lastAction(villager!, 'kill')).toBeUndefined()
    // And the SAME sentence in the public room is not a kill at all — the kill
    // exists only in the den.
    const before = f.world.events().filter((e) => e.type === 'action.kill').length
    await f.say(wolf!, 'room', `we kill ${villager!} tonight.`)
    expect(f.world.events().filter((e) => e.type === 'action.kill')).toHaveLength(before)
  })

  it('gives the pack ONE kill a night: the first clear statement carries, the second is a duplicate', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const villagers = f.byRole('villager')
    // Both wolves speak in the same wave — the night resolves once the world
    // reads them, so the pack's disagreement is settled by who said it first.
    await f.post(wolves[0]!, 'den', `we kill ${villagers[0]!} tonight.`)
    await f.post(wolves[1]!, 'den', `no, let's kill ${villagers[1]!} instead.`)
    f.apply()
    expect(f.lastAction(wolves[0]!, 'kill')).toMatchObject({ disposition: 'accepted', target: villagers[0]! })
    expect(f.lastAction(wolves[1]!, 'kill')).toMatchObject({
      disposition: 'duplicate',
      reason: 'kill_already_chosen'
    })
  })

  it('records an ambiguous statement as unparseable and never guesses which player was meant', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const villagers = f.byRole('villager')
    // Two different targets, both stated as kills: the referee refuses to pick.
    await f.post(wolves[0]!, 'den', `we could kill ${villagers[0]!} or kill ${villagers[1]!}.`)
    // Nothing was applied by the ambiguous line, so a clear one still lands —
    // in the same wave, because the night resolves as soon as one does.
    await f.post(wolves[0]!, 'den', `settled — we kill ${villagers[0]!}.`)
    f.apply()
    const kills = f.world.events().filter((e) => e.type === 'action.kill')
    expect(kills[0]).toMatchObject({ disposition: 'unparseable' })
    expect(String(kills[0]!.reason)).toMatch(/^ambiguous:/)
    expect(kills[1]).toMatchObject({ disposition: 'accepted', target: villagers[0]! })
  })

  it('treats ordinary coordination talk as conversation, not as a failed action', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const before = f.world.events().filter((e) => e.type === 'action.kill').length
    // Discussing without naming a target states nothing — and is not an error.
    await f.say(wolves[0]!, 'den', 'who feels safest to take tonight? I have no strong read yet.')
    expect(f.world.events().filter((e) => e.type === 'action.kill')).toHaveLength(before)
  })

  it('reads the seer and doctor night actions out of their own referee DMs', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const [seer] = f.byRole('seer')
    const [doctor] = f.byRole('doctor')
    const villagers = f.byRole('villager')
    await f.say(seer!, 'dm', `I inspect ${villagers[0]!} tonight.`)
    expect(f.lastAction(seer!, 'inspect')).toMatchObject({ disposition: 'accepted', target: villagers[0]! })
    await f.say(doctor!, 'dm', `I protect ${villagers[1]!} tonight.`)
    expect(f.lastAction(doctor!, 'protect')).toMatchObject({ disposition: 'accepted', target: villagers[1]! })
    // The seer saying it in the PUBLIC room is not a night action.
    const before = f.world.events().filter((e) => e.type === 'action.inspect').length
    await f.say(seer!, 'room', `I inspect ${villagers[2]!} tonight.`)
    expect(f.world.events().filter((e) => e.type === 'action.inspect')).toHaveLength(before)
  })

  it('does not mistake day-discussion talk about voting for an actual vote', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const villagers = f.byRole('villager')
    await f.say(wolves[0]!, 'den', `we kill ${villagers[0]!} tonight.`) // night resolves → DAY n
    // People reason out loud about voting all through the discussion. That is
    // conversation, and the referee only reads votes once it has asked for them.
    await f.say(villagers[1]!, 'room', `I'd probably vote for ${wolves[0]!} if nothing changes.`)
    expect(f.lastAction(villagers[1]!, 'vote')).toBeUndefined()
    // Once the referee closes discussion and calls for votes, the same sentence counts.
    f.openVote()
    await f.say(villagers[1]!, 'room', `I vote for ${wolves[0]!}.`)
    expect(f.lastAction(villagers[1]!, 'vote')).toMatchObject({ disposition: 'accepted' })
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
    await f.say(wolves[0]!, 'den', `we kill ${villagers[0]!} tonight.`)
    await f.say(doctor!, 'dm', `I protect ${villagers[1]!}.`)
    await f.say(seer!, 'dm', `I inspect ${wolves[0]!}.`)
    f.game.applyEffects([])
    f.openVote()
    // Day 1: the victim is dead — their vote is rejected on aliveness.
    await f.say(villagers[0]!, 'room', `I vote for ${wolves[0]!}.`)
    expect(f.lastAction(villagers[0]!, 'vote')).toMatchObject({ disposition: 'rejected', reason: 'dead_player' })
    // Everyone living votes the inspected wolf except the wolves.
    for (const alias of [seer!, doctor!, villagers[1]!, villagers[2]!]) {
      await f.say(alias, 'room', `I vote for ${wolves[0]!}.`)
      expect(f.lastAction(alias, 'vote')).toMatchObject({ disposition: 'accepted' })
    }
    await f.say(wolves[0]!, 'room', `I vote for ${seer!}.`)
    await f.say(wolves[1]!, 'room', `I vote for ${seer!}.`)
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
    // The same canary in the wolf den is NOT a leak — that room is private to
    // wolves, and with actions as messages this IS the visibility model.
    await f.say(wolfAlias!, 'den', `between us: ${wolf}`)
    expect(f.game.verdict().invariants.privateLeaks).toBe(1)
  })
})

describe('werewolf end to end — scripted role-followers over real sessions and §6 tools', () => {
  it('plays a full seeded game through the daemon: private roles, spoken actions, a winner, zero leaks', async () => {
    const artifactDir = join(scratch(), 'run')
    const result = await runWerewolf({ seed: 42, playerCount: 5, artifactDir, timeoutMs: 240_000 })
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
    expect(result.verdict.metrics.inspections).toBeGreaterThanOrEqual(1)
    const events = worldEvents(result.paths.worldEvents)
    // Actions were parsed out of MESSAGES, with the same dispositions as before.
    expect(events.some((event) => event.type === 'action.kill' && event.disposition === 'accepted')).toBe(true)
    // A five-player table can end at night 1 (one kill makes it 2-vs-2), so a
    // day vote is not guaranteed here — the multi-round suite covers voting.
    expect(events.some((event) => String(event.type).startsWith('action.'))).toBe(true)
    // …and the game registers no evaluation tools at all any more.
    expect(events.some((event) => String(event.type).startsWith('tool.'))).toBe(false)
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
    const first = await runWerewolf({ seed: 9, playerCount: 5, artifactDir: join(scratch(), 'a'), timeoutMs: 240_000 })
    const second = await runWerewolf({ seed: 9, playerCount: 5, artifactDir: join(scratch(), 'b'), timeoutMs: 240_000 })
    expect(first.status).toBe('passed')
    expect(second.status).toBe('passed')
    expect(first.verdict.outcome.roles).toEqual(second.verdict.outcome.roles)
    expect(first.verdict.outcome.winner).toBe(second.verdict.outcome.winner)
  }, 600_000)
})

describe('werewolf multi-round play — night → sequential day → vote → resolution', () => {
  it('runs real rounds off parsed messages and ends on a rule, not on a crash', async () => {
    // Seven scripted players, and this is the SCRIPTED boundary (see the next
    // test): the point here is that every phase of every round is driven by
    // parsed conversation and the game ends for a stated reason.
    const result = await runWerewolf({
      seed: 42,
      playerCount: 7,
      artifactDir: join(scratch(), 'multiround'),
      maxSteps: 200,
      timeoutMs: 300_000
    })
    expect(result.status).toBe('passed')
    expect(['completed', 'round_limit']).toContain(result.verdict.terminalReason)
    expect(result.verdict.refereeConsistent).toBe(true)

    // Multiple night/day cycles really ran, each opened by the referee.
    expect(Number(result.verdict.outcome.rounds)).toBeGreaterThanOrEqual(2)
    expect(result.verdict.metrics.daysOpened).toBeGreaterThanOrEqual(2)

    // Actions came from MESSAGES in their own conversations, with the same
    // dispositions the tool handlers used to produce.
    expect(result.verdict.metrics.kills).toBeGreaterThanOrEqual(1)
    expect(result.verdict.metrics.inspections).toBeGreaterThanOrEqual(1)
    expect(result.verdict.metrics.protections).toBeGreaterThanOrEqual(1)
    expect(result.verdict.metrics.votesCast).toBeGreaterThanOrEqual(1)

    // No leak, no unauthorized effect — role visibility is room membership now.
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })

    // Phase order per round is night → day open → day close → day resolve.
    const events = worldEvents(result.paths.worldEvents)
    const phases = events
      .map((event) => String(event.type))
      .filter((type) =>
        ['night.resolved', 'day.discussion_opened', 'day.discussion_closed', 'day.resolved'].includes(type)
      )
    expect(phases.length).toBeGreaterThanOrEqual(8)
    for (let index = 0; index + 3 < phases.length; index += 4) {
      expect(phases.slice(index, index + 4)).toEqual([
        'night.resolved',
        'day.discussion_opened',
        'day.discussion_closed',
        'day.resolved'
      ])
    }
  }, 300_000)

  it('a five-player table plays through to a winner on parsed messages alone', async () => {
    const result = await runWerewolf({
      seed: 42,
      playerCount: 5,
      artifactDir: join(scratch(), 'five'),
      timeoutMs: 240_000
    })
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('completed')
    const winner = result.verdict.outcome.winner as 'village' | 'werewolves'
    expect(['village', 'werewolves']).toContain(winner)
    // The win condition holds against the survivors.
    const roles = result.verdict.outcome.roles as Record<string, string>
    const survivors = result.verdict.outcome.survivors as string[]
    const livingWolves = survivors.filter((alias) => roles[alias] === 'werewolf').length
    if (winner === 'village') expect(livingWolves).toBe(0)
    else expect(livingWolves).toBeGreaterThanOrEqual(survivors.length - livingWolves)
    expect(result.verdict.metrics.kills).toBeGreaterThanOrEqual(1)
    expect(result.verdict.invariants.privateLeaks).toBe(0)
  }, 300_000)

  it('SCRIPTED BOUNDARY: a seven-player game exhausts the budget inside one 60s window', async () => {
    // Actions are messages now, so a day costs the room its discussion AND its
    // votes — roughly double the traffic the tool path charged. A scripted game
    // finishes in about two seconds, so every round lands inside ONE 60s
    // loop-guard window and the budget never refreshes: circuits latch at
    // exactly MAX_AUTOMATIC_TURNS_PER_WINDOW and the later rounds are empty.
    //
    // This is a property of scripted SPEED, not of the design: the same table
    // with real models takes ~90s for round 1 alone, the window rolls, and the
    // game completes with zero gated wakes (baseline §5.4). Pinned so a change
    // in either direction is visible.
    const result = await runWerewolf({
      seed: 42,
      playerCount: 7,
      artifactDir: join(scratch(), 'scripted-boundary'),
      maxSteps: 200,
      timeoutMs: 300_000
    })
    expect(result.status).toBe('passed')
    const wakes = result.verdict.outcome.peerWakes as Record<string, { admitted: number; gated: number }>
    const latched = result.verdict.outcome.loopGuardLatched as string[]
    expect(latched.length).toBeGreaterThan(0)
    expect(result.verdict.metrics.peerWakesGated).toBeGreaterThan(0)
    // Every latched non-wolf holds exactly one circuit and stops at the budget.
    const roles = result.verdict.outcome.roles as Record<string, string>
    for (const alias of latched.filter((name) => roles[name] !== 'werewolf')) {
      expect(wakes[alias]!.admitted).toBe(8)
      expect(wakes[alias]!.gated).toBeGreaterThan(0)
    }
    // The wolves hold TWO circuits — the public room and the den — so they
    // absorb more before latching. That is the den echo being real ingress.
    for (const alias of Object.keys(roles).filter((name) => roles[name] === 'werewolf')) {
      expect(wakes[alias]!.admitted).toBeGreaterThan(8)
    }
    // And the game still ends on a rule, with no invariant touched.
    expect(result.verdict.invariants).toMatchObject({ privateLeaks: 0, attemptedUnauthorizedEffects: 0 })
  }, 300_000)
})

describe('werewolf day phase — natural sequential discussion driven by peer messages', () => {
  it('opens the day once and then advances only on players continuing each other', async () => {
    const artifactDir = join(scratch(), 'sequential')
    const result = await runWerewolf({ seed: 42, artifactDir, timeoutMs: 240_000 })
    expect(result.status).toBe('passed')
    const days = result.verdict.outcome.dayDiscussions as DayRecord[]
    expect(days.length).toBeGreaterThanOrEqual(1)

    // The FIRST day is the one with a full budget behind it: every speech lands
    // on the announced order, exactly once each, in order. Later scripted days
    // run on an exhausted window (see the SCRIPTED BOUNDARY test), so they are
    // allowed to stall — but nothing may ever speak OUT of order.
    expect(days[0]!.outcome).toBe('order_complete')
    expect(days[0]!.spoke).toEqual(days[0]!.order)
    expect(days[0]!.neverSpoke).toEqual([])
    for (const day of days) {
      expect(day.outOfOrder).toEqual([])
      expect(day.reachedVote).toBe(true)
      expect(day.spoke).toEqual(day.order.slice(0, day.spoke.length))
    }

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
    // The echo really is the transport: every delivered speech wakes the other
    // room members. Exact equality no longer holds — the den echo and the public
    // votes are ingress too — so assert the floor the discussion alone implies.
    const members = (result.verdict.outcome.roles as Record<string, string>) ?? {}
    const memberCount = Object.keys(members).length
    expect(result.verdict.metrics.peerWakesAdmitted).toBeGreaterThanOrEqual(
      Number(result.verdict.metrics.speechesDelivered) * (memberCount - 1)
    )
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
