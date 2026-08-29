import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countingManifest, runQuotaCounting } from '../games/engine.js'
import { QuotaCountingGame } from '../games/quota-counting.js'
import { compileTopology } from '../games/topology.js'
import { ArenaWorld } from '../games/world.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-quota-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

function fixture(agents: string[], quotaPerAgent: number) {
  const topology = compileTopology(countingManifest({ seed: 17, agents }))
  const world = new ArenaWorld(topology)
  const game = new QuotaCountingGame({ world, roomAlias: 'counting-room', quotaPerAgent })
  game.attachLiveIngress(
    () =>
      ({
        admission: Promise.resolve({ admitted: false, reason: 'gated' }),
        completion: Promise.resolve({ status: 'not_admitted' })
      }) as never
  )
  const room = topology.rooms[0]!
  const reply = async (alias: string, text: string) => {
    const integration = topology.integrations.find((i) => i.agentAlias === alias)!
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
  return { topology, world, game, room, reply, apply }
}

describe('quota counting referee — leaderless turn-taking with a real endgame hazard', () => {
  it('states the full rule set once, then stays silent', () => {
    const { game } = fixture(['agent-a', 'agent-b'], 5)
    const start = game.nextDeliveries()
    const text = start.platformEvents[0]!.payload.text
    expect(text).toContain('Participants: agent-a, agent-b')
    expect(text).toContain('exactly 5 numbers in total')
    expect(text).toContain('cannot post twice in a row')
    expect(text).toContain('ends at 10')
    expect(text).toContain('referee stays silent')
    expect(game.nextDeliveries().platformEvents).toHaveLength(0)
  })

  it('completes clean when the sequence is right, quotas are exact, and turn-taking held', async () => {
    const f = fixture(['agent-a', 'agent-b'], 2)
    f.game.nextDeliveries()
    for (const [index, alias] of ['agent-a', 'agent-b', 'agent-a', 'agent-b'].entries()) {
      await f.reply(alias, String(index + 1))
      f.apply()
    }
    expect(f.game.isTerminal()).toBe(true)
    const verdict = f.game.verdict()
    expect(verdict.terminalReason).toBe('completed')
    expect(verdict.outcome).toMatchObject({
      completed: true,
      endgame: 'completed-clean',
      deadlocked: false,
      contributions: { 'agent-a': 2, 'agent-b': 2 },
      remainingQuota: { 'agent-a': 0, 'agent-b': 0 },
      contributionOrder: ['agent-a', 'agent-b', 'agent-a', 'agent-b']
    })
    expect(verdict.metrics).toMatchObject({ consecutivePostViolations: 0, overQuotaContributions: 0 })
    expect(verdict.refereeConsistent).toBe(true)
  })

  it('OBSERVES consecutive and over-quota posts instead of policing them; the sequence still completes', async () => {
    const f = fixture(['agent-a', 'agent-b'], 2)
    f.game.nextDeliveries()
    // agent-a hogs the first two slots (consecutive violation), then agent-b
    // takes 3, and agent-a posts a THIRD number (over quota) to finish.
    for (const [index, alias] of ['agent-a', 'agent-a', 'agent-b', 'agent-a'].entries()) {
      await f.reply(alias, String(index + 1))
      f.apply()
    }
    const verdict = f.game.verdict()
    expect(verdict.outcome).toMatchObject({
      completed: false,
      endgame: 'completed-with-violations',
      acceptedPrefix: 4,
      contributions: { 'agent-a': 3, 'agent-b': 1 }
    })
    expect(verdict.metrics.consecutivePostViolations).toBe(1)
    expect(verdict.metrics.overQuotaContributions).toBe(1)
  })

  it('classifies the endgame hazard: one hoarder left holding >=2 once everyone else exhausted', async () => {
    const f = fixture(['agent-a', 'agent-b', 'agent-c'], 2)
    f.game.nextDeliveries()
    // a and b alternate to exhaustion; c never posts. No one is left to
    // interleave c's two remaining posts — the count can never finish.
    for (const [index, alias] of ['agent-a', 'agent-b', 'agent-a', 'agent-b'].entries()) {
      await f.reply(alias, String(index + 1))
      f.apply()
    }
    expect(f.game.isTerminal()).toBe(false)
    f.game.terminate('stalled')
    const verdict = f.game.verdict()
    expect(verdict.terminalReason).toBe('deadlocked')
    expect(verdict.outcome).toMatchObject({
      completed: false,
      endgame: 'deadlocked',
      deadlocked: true,
      acceptedPrefix: 4,
      remainingQuota: { 'agent-a': 0, 'agent-b': 0, 'agent-c': 2 }
    })
  })

  it('keeps a plain multi-agent stall distinct from a deadlock', async () => {
    const f = fixture(['agent-a', 'agent-b'], 2)
    f.game.nextDeliveries()
    await f.reply('agent-a', '1')
    f.apply()
    f.game.terminate('stalled')
    const verdict = f.game.verdict()
    expect(verdict.terminalReason).toBe('stalled')
    expect(verdict.outcome).toMatchObject({
      endgame: 'stalled',
      deadlocked: false,
      remainingQuota: { 'agent-a': 1, 'agent-b': 2 }
    })
  })

  it('treats post-completion acknowledgments as termination awareness, never noise', async () => {
    const f = fixture(['agent-a', 'agent-b'], 1)
    f.game.nextDeliveries()
    await f.reply('agent-a', '1')
    await f.reply('agent-b', '2')
    f.apply()
    expect(f.game.isTerminal()).toBe(true)
    await f.reply('agent-a', '2 has already been posted, so the count is complete.')
    f.apply()
    const verdict = f.game.verdict()
    expect(verdict.metrics.terminationAcknowledgments).toBe(1)
    expect(verdict.metrics.noiseReplies).toBe(0)
  })
})

describe('quota counting end to end — scripted hosts over the real daemon', () => {
  it('two participants complete the quota on echo routing alone, with no referee cadence', async () => {
    const result = await runQuotaCounting({
      seed: 5,
      agents: ['agent-a', 'agent-b'],
      quotaPerAgent: 2,
      artifactDir: join(scratch(), 'echo-routed'),
      timeoutMs: 120_000
    })
    expect(result.error).toBeUndefined()
    // Measured behavior on current main (#503 + #549 + #568): the referee's
    // start broadcast admits every member once and then the referee is silent.
    // Each delivered post fans back as the production echo — only `final`
    // claims route (a single-post reply closes at post time, so its one echo
    // already carries them — §5.5), verified through the ordinary arbitration
    // ladder. Since #568 an admitted continuation binds the conversation
    // audience of the session a HUMAN opened, so the exchange survives the
    // wrap-around and the pair counts out its full quota with perfect
    // alternation.
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.outcome).toMatchObject({
      completed: true,
      endgame: 'completed-clean',
      deadlocked: false,
      acceptedPrefix: 4
    })
    expect(result.verdict.outcome.contributions).toEqual({ 'agent-a': 2, 'agent-b': 2 })
    const remaining = Object.values(result.verdict.outcome.remainingQuota as Record<string, number>)
    expect(remaining.reduce((sum, value) => sum + value, 0)).toBe(0)
    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // One referee message, one ingress wave: every later turn came from an
    // agent's own post, through real routing.
    expect(worldEvents.filter((event) => event.type === 'referee.room_event')).toHaveLength(1)
    expect(worldEvents.filter((event) => event.type === 'wave')).toHaveLength(1)
    const outcomes = worldEvents.filter((event) => event.type === 'platform.echo.outcome')
    // Streaming never routes; every admitted echo carried the `final` claim. Single-post
    // turns produce no separate streaming copy (born-final, §5.5) — the parity suite's
    // streaming-never-routes scenario pins the suppression path explicitly.
    const streaming = outcomes.filter((event) => event.deliveryState !== 'final')
    const finalized = outcomes.filter((event) => event.deliveryState === 'final')
    for (const outcome of streaming) expect(outcome).toMatchObject({ admitted: false, reason: 'suppressed' })
    expect(finalized.filter((outcome) => outcome.admitted === true).length).toBeGreaterThan(0)
    // The #583 regression pin: no turn was lost to source binding.
    const events = readFileSync(result.paths.events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      events.some((event) => event.type === 'turn.cancelled' && event.data?.reason === 'session_source_mismatch')
    ).toBe(false)
  }, 150_000)

  it('four dedicated bots saturate the automatic-turn budget before the ring can start', async () => {
    const result = await runQuotaCounting({
      seed: 5,
      agents: ['agent-a', 'agent-b', 'agent-c', 'agent-d'],
      quotaPerAgent: 2,
      artifactDir: join(scratch(), 'echo-saturated'),
      timeoutMs: 120_000
    })
    expect(result.error).toBeUndefined()
    // The compounding #549 warns about, measured: each dedicated bot receives
    // the channel event on its OWN connection, so one post wakes every other
    // participant. With four members the wake fan-out outruns the durable loop
    // guard's automatic-turn budget — turns are ADMITTED and then dropped
    // unstarted once it latches, and participants whose ring position never
    // came up never speak at all. A valid observed outcome, with the untouched
    // quota on record; the room is bounded by the protections, not by the game.
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('stalled')
    expect(result.verdict.outcome).toMatchObject({ completed: false, endgame: 'stalled' })
    const acceptedPrefix = result.verdict.outcome.acceptedPrefix as number
    const remaining = Object.values(result.verdict.outcome.remainingQuota as Record<string, number>)
    expect(remaining.reduce((sum, value) => sum + value, 0)).toBe(8 - acceptedPrefix)
    const events = readFileSync(result.paths.events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Far more turns were admitted than ever ran, and the loop guard is what
    // stopped them — NOT a routing refusal and NOT source binding (#583).
    const accepted = events.filter((event) => event.type === 'turn.accepted').length
    const started = events.filter((event) => event.type === 'turn.started').length
    expect(accepted).toBeGreaterThan(started)
    expect(events.some((event) => event.type === 'turn.cancelled' && /loop/i.test(String(event.data?.reason)))).toBe(
      true
    )
    expect(
      events.some((event) => event.type === 'turn.cancelled' && event.data?.reason === 'session_source_mismatch')
    ).toBe(false)
  }, 150_000)
})
