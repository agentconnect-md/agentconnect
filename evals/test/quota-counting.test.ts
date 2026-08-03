import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CollaborationGameRunner } from '../../packages/daemon/src/evaluation/index.js'
import { countingManifest, runQuotaCounting, scaffoldSubject } from '../games/engine.js'
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
  it('a cooperative group completes with exact quotas and clean turn-taking', async () => {
    const result = await runQuotaCounting({
      seed: 5,
      agents: ['agent-a', 'agent-b', 'agent-c', 'agent-d'],
      quotaPerAgent: 2,
      artifactDir: join(scratch(), 'complete'),
      timeoutMs: 120_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.outcome).toMatchObject({
      completed: true,
      endgame: 'completed-clean',
      acceptedPrefix: 8,
      target: 8,
      contributions: { 'agent-a': 2, 'agent-b': 2, 'agent-c': 2, 'agent-d': 2 }
    })
    expect(result.verdict.metrics).toMatchObject({ consecutivePostViolations: 0, overQuotaContributions: 0 })
    expect(result.verdict.metrics.participationEntropy).toBe(1)
    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Leaderless: the referee spoke exactly once; peer relays drove the rest.
    expect(worldEvents.filter((event) => event.type === 'referee.room_event')).toHaveLength(1)
    expect(worldEvents.filter((event) => event.type === 'peer.relay').length).toBeGreaterThanOrEqual(8)
  }, 150_000)

  it('a group with a hoarder deadlocks and is reported as such, with remaining quota', async () => {
    const topology = compileTopology(countingManifest({ seed: 6, agents: ['agent-a', 'agent-b', 'agent-c'] }))
    const hoarderId = topology.agents.find((agent) => agent.alias === 'agent-c')!.agentId
    const world = new ArenaWorld(topology)
    const game = new QuotaCountingGame({ world, roomAlias: 'counting-room', quotaPerAgent: 2 })
    const subject = scaffoldSubject(topology)
    try {
      const runner = new CollaborationGameRunner({
        root: subject.root,
        world: game,
        artifactDir: join(scratch(), 'deadlock'),
        game: 'quota-counting',
        seed: 6,
        mode: 'deterministic',
        subjectKind: 'scripted',
        hostFactory: ((agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
          // Deterministic choreography: agent-a claims the odd numbers,
          // agent-b the even ones, agent-c hoards (never posts). a and b
          // exhaust their quotas on 1..4, then no one can interleave c's two
          // remaining posts — the variant's endgame hazard, on purpose.
          const aliasOf = new Map(topology.agents.map((entry) => [entry.agentId, entry.alias]))
          const alias = aliasOf.get(agent.id)!
          const state = { mine: 0, myLast: 0 }
          return {
            start: async () => {},
            newSession: async () => `deadlock-${agent.id.slice(0, 8)}`,
            hasSession: () => true,
            modelOptions: () => ({ current: 'scripted', models: ['scripted'] }),
            prompt: async (sessionId: string, blocks: { text?: string }[]) => {
              const text = blocks.map((block) => block.text ?? '').join('\n')
              const reply = (value: string) =>
                onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
              const posted: number[] = []
              for (const line of text.matchAll(/\[(U-[A-Z0-9-]+)\]\s*(-?\d+)\s*$/gm)) posted.push(Number(line[2]))
              const maxSeen = Math.max(0, ...posted, state.myLast)
              const next = maxSeen + 1
              const wantsParity = alias === 'agent-a' ? 1 : alias === 'agent-b' ? 0 : -1
              if (wantsParity === -1 || state.mine >= 2 || next % 2 !== wantsParity) {
                reply('waiting.')
                return { stopReason: 'end_turn' }
              }
              state.mine += 1
              state.myLast = next
              reply(String(next))
              return { stopReason: 'end_turn' }
            },
            cancel: async () => {},
            stop: async () => {}
          }
        }) as never,
        capabilityProfile: { memory: 'off', collaboration: 'configured' },
        limits: { maxSteps: 20, timeoutMs: 90_000 },
        agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias }))
      })
      const result = await runner.run()
      // The trial is VALID — the group deadlocking is a legitimate observed
      // outcome, not an infrastructure failure.
      expect(result.status).toBe('passed')
      expect(result.verdict.terminalReason).toBe('deadlocked')
      expect(result.verdict.outcome).toMatchObject({
        completed: false,
        endgame: 'deadlocked',
        deadlocked: true,
        remainingQuota: { 'agent-a': 0, 'agent-b': 0, 'agent-c': 2 }
      })
    } finally {
      subject.cleanup()
    }
  }, 150_000)
})
