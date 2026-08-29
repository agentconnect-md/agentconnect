import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runSameRoomCounting } from '../games/engine.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-arena-artifacts-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

describe('collaboration game runner — same-room counting with scripted hosts', () => {
  it('completes the counting game through the real daemon and writes all six coherent artifacts', async () => {
    const artifactDir = join(scratch(), 'run-1')
    const result = await runSameRoomCounting({ seed: 42, target: 12, artifactDir, timeoutMs: 90_000 })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.valid).toBe(true)
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.refereeConsistent).toBe(true)
    expect(result.verdict.outcome).toMatchObject({ completed: true, acceptedPrefix: 12, target: 12 })
    // §9.2 hard gates: zero attempted violations.
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })

    // Existing artifact layers.
    for (const path of [result.paths.manifest, result.paths.events, result.paths.trajectory]) {
      expect(existsSync(path)).toBe(true)
    }
    const manifest = JSON.parse(readFileSync(result.paths.manifest, 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 'agentconnect.eval-run/v1',
      caseId: 'same-room-counting',
      status: 'passed'
    })

    // New game artifact layers (§11).
    const gameResult = JSON.parse(readFileSync(result.paths.gameResult, 'utf8'))
    expect(gameResult).toMatchObject({
      schemaVersion: 'agentconnect.game-result/v1',
      game: 'same-room-counting',
      seed: 42,
      mode: 'deterministic',
      subjectKind: 'scripted',
      valid: true,
      terminalReason: 'completed',
      outcome: { completed: true, acceptedPrefix: 12, target: 12 }
    })

    const topology = JSON.parse(readFileSync(result.paths.topology, 'utf8'))
    expect(topology.aliasMap.agents['agent-a']).toMatch(/^[0-9a-f-]{36}$/)
    expect(topology.aliasMap.rooms['counting-room'].channel).toMatch(/^C[A-Z0-9]{10}$/)

    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Monotonic sequence over the unified stream.
    const sequences = worldEvents.map((event) => event.sequence)
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences)
    // The referee accepted exactly 1..12, and never the same agent twice in a row.
    const acceptedCandidates = worldEvents.filter((event) => event.type === 'count.candidate' && event.accepted)
    expect(acceptedCandidates.map((event) => event.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    for (let i = 1; i < acceptedCandidates.length; i++) {
      expect(acceptedCandidates[i].agentId).not.toBe(acceptedCandidates[i - 1].agentId)
    }
    // Referee room events are tagged origin: 'referee' (§4.2 exclusion rule).
    expect(worldEvents.some((event) => event.origin === 'referee' && event.type === 'referee.room_event')).toBe(true)
    // Concurrent fan-out: waves address every member integration.
    const waves = worldEvents.filter((event) => event.type === 'wave')
    expect(waves.length).toBeGreaterThanOrEqual(12)
    expect(waves[0].platformEvents).toHaveLength(4)
    // Wave admissions: every injected copy was admitted through real routing.
    for (const wave of waves) {
      for (const admission of wave.admissions) expect(admission.admitted).toBe(true)
    }
    // Collisions happened (all four agents propose every round) and were scored.
    expect(gameResult.metrics.collisions).toBeGreaterThan(0)
  }, 120_000)

  it('peer-driven variant: finalized bare-number posts carry the count to completion, then the loop protections stop the room', async () => {
    const artifactDir = join(scratch(), 'peer-run')
    const result = await runSameRoomCounting({
      seed: 11,
      target: 6,
      artifactDir,
      variant: 'peer-driven',
      timeoutMs: 120_000
    })
    expect(result.error).toBeUndefined()
    // The measured behavior on current main (#503 + #549 + #568):
    //  1. The referee's start broadcast admits every member once; ONE wave.
    //  2. Each delivered agent post fans back as the production echo. Only the
    //     `final` claim routes — a single-post reply closes at post time, so
    //     its one echo already carries it (§5.5) — verifies, and, naming
    //     nobody, takes the ordinary arbitration ladder, which ADMITS every
    //     other member's connection (dedicated-bot fan-out).
    //  3. Since #568 an admitted continuation can bind the conversation
    //     audience of the session a HUMAN opened, so the exchange no longer
    //     dies at the first wrap-around: the room counts all the way to the
    //     target with no referee cadence at all.
    //  4. What stops it afterwards is the loop protections #549 names as the
    //     ordinary terminators — the hop cap and the durable automatic-turn
    //     loop guard — not a routing refusal.
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.outcome).toMatchObject({ completed: true, variant: 'peer-driven', acceptedPrefix: 6 })
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })
    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // The referee spoke exactly once, and there was exactly ONE ingress wave:
    // every later activation came from an agent, through real routing.
    expect(worldEvents.filter((event) => event.type === 'referee.room_event')).toHaveLength(1)
    expect(worldEvents.filter((event) => event.type === 'wave')).toHaveLength(1)
    // Echoes went out under the REAL managed bot identities with the §4 claim.
    const echoes = worldEvents.filter((event) => event.type === 'platform.echo')
    expect(echoes.length).toBeGreaterThanOrEqual(2)
    const outcomes = worldEvents.filter((event) => event.type === 'platform.echo.outcome')
    // Final events only: a streaming echo never routes. Single-post turns close their
    // response at post time (§5.5), so no separate streaming copy exists here — the
    // parity suite's streaming-never-routes scenario pins the suppression path.
    const streaming = outcomes.filter((event) => event.deliveryState !== 'final')
    const finalized = outcomes.filter((event) => event.deliveryState === 'final')
    for (const outcome of streaming) expect(outcome).toMatchObject({ admitted: false, reason: 'suppressed' })
    // #549: a finalized post naming NOBODY is admitted on every other member's
    // connection — one agent message wakes every other agent (fan-out) — until
    // a loop protection latches, after which further echoes route to nobody.
    expect(finalized.filter((outcome) => outcome.admitted === true).length).toBeGreaterThan(0)
    // The accepted values are a clean 1..target run: no duplicate or skipped slot.
    const accepted = worldEvents.filter((event) => event.type === 'count.candidate' && event.accepted)
    expect(accepted.map((event) => event.value)).toEqual([1, 2, 3, 4, 5, 6])
    // The #583 regression pin: not one turn was lost to source binding.
    const events = readFileSync(result.paths.events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      events.some((event) => event.type === 'turn.cancelled' && event.data?.reason === 'session_source_mismatch')
    ).toBe(false)
    // A leaderless room does NOT stop counting at the target — it runs on until
    // a loop protection stops it. That is the headline property of the probe:
    // the exchange is bounded by the protections, never by the game's goal.
    const overshoot = worldEvents.filter(
      (event) => event.type === 'count.candidate' && event.reason === 'post_completion'
    )
    expect(overshoot.length).toBeGreaterThan(0)
    const stoppedByProtection =
      events.some((event) => event.type === 'turn.cancelled' && /loop/i.test(String(event.data?.reason))) ||
      outcomes.some((outcome) => outcome.admitted === false && outcome.reason === 'unrouted')
    expect(stoppedByProtection).toBe(true)
  }, 180_000)

  it('a slow in-flight turn REGENERATES when a peer post lands mid-turn, and posts the NEXT number', async () => {
    // Production timing, deterministically: agent-a answers instantly, agent-b
    // is still working when agent-a's post is relayed. agent-b had decided on
    // the same number; the daemon's turn-final context refresh must invalidate
    // that staged answer and re-prompt it with the peer message included.
    const { CollaborationGameRunner } = await import('../../packages/daemon/src/evaluation/index.js')
    const { compileTopology } = await import('../games/topology.js')
    const { ArenaWorld } = await import('../games/world.js')
    const { CountingGame } = await import('../games/counting.js')
    const { countingManifest, scaffoldSubject } = await import('../games/engine.js')
    const topology = compileTopology(countingManifest({ seed: 21, agents: ['agent-a', 'agent-b'] }))
    const slowAgentId = topology.agents.find((agent) => agent.alias === 'agent-b')!.agentId
    const world = new ArenaWorld(topology)
    const game = new CountingGame({ world, roomAlias: 'counting-room', target: 2, variant: 'peer-driven' })
    const subject = scaffoldSubject(topology)
    const posts: { agent: string; text: string; generation: number }[] = []
    try {
      const runner = new CollaborationGameRunner({
        root: subject.root,
        world: game,
        artifactDir: join(scratch(), 'regen'),
        game: 'same-room-counting',
        seed: 21,
        mode: 'deterministic',
        subjectKind: 'scripted',
        hostFactory: ((agent: { id: string }, onUpdate: (sessionId: string, update: unknown) => void) => {
          let generation = 0
          return {
            start: async () => {},
            newSession: async () => `regen-${agent.id.slice(0, 8)}`,
            hasSession: () => true,
            modelOptions: () => ({ current: 'regen', models: ['regen'] }),
            prompt: async (sessionId: string, blocks: { text?: string }[]) => {
              const text = blocks.map((block) => block.text ?? '').join('\n')
              // agent-a is slow enough that agent-b's turn is already RUNNING
              // when its post lands; agent-b is slower still, so the peer post
              // arrives mid-turn and must invalidate its staged answer.
              if (agent.id !== slowAgentId && generation === 0) {
                await new Promise((resolve) => setTimeout(resolve, 300))
              }
              if (agent.id === slowAgentId && generation === 0) {
                await new Promise((resolve) => setTimeout(resolve, 900))
              }
              const posted: number[] = []
              for (const line of text.matchAll(/\[[^\]\n]+\]\s*(-?\d+)\s*$/gm)) posted.push(Number(line[1]))
              const next = Math.max(0, ...posted) + 1
              posts.push({ agent: agent.id === slowAgentId ? 'agent-b' : 'agent-a', text: String(next), generation })
              generation += 1
              onUpdate(sessionId, {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: String(next) }
              })
              return { stopReason: 'end_turn' }
            },
            cancel: async () => {},
            stop: async () => {}
          }
        }) as never,
        capabilityProfile: { memory: 'off' },
        limits: { maxSteps: 12, timeoutMs: 120_000 },
        agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias }))
      })
      const result = await runner.run()
      expect(result.status).toBe('passed')
      const events = readFileSync(result.paths.events, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      // The fence fired: the staged stale answer was discarded and re-prompted.
      const regenerations = events.filter((event) => event.type === 'turn.regeneration_started')
      expect(regenerations.length).toBeGreaterThan(0)
      expect(events.some((event) => event.type === 'turn.context_changed')).toBe(true)
      // The slow agent decided "1" on generation 0 and "2" after regenerating.
      const slowAttempts = posts.filter((post) => post.agent === 'agent-b')
      expect(slowAttempts[0]).toMatchObject({ text: '1', generation: 0 })
      expect(slowAttempts.some((post) => post.generation > 0 && post.text === '2')).toBe(true)
      // And the stale "1" never reached the room a second time.
      const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const delivered = worldEvents.filter((event) => event.type === 'outbound.delivered' && event.kind === 'reply')
      expect(delivered.filter((event) => event.text === '1')).toHaveLength(1)
      expect(result.verdict.outcome).toMatchObject({ completed: true, acceptedPrefix: 2 })
    } finally {
      subject.cleanup()
    }
  }, 180_000)

  it('classifies a game stalled by failing turns as infra_error, never a passed trial (§9.1)', async () => {
    // A subject whose host cannot complete any turn (e.g. an unreachable model)
    // must invalidate the trial — the scripted default is replaced by a
    // scripted-shaped subject whose runtime rejects every prompt.
    const { CollaborationGameRunner } = await import('../../packages/daemon/src/evaluation/index.js')
    const { compileTopology } = await import('../games/topology.js')
    const { ArenaWorld } = await import('../games/world.js')
    const { CountingGame } = await import('../games/counting.js')
    const { countingManifest, scaffoldSubject } = await import('../games/engine.js')
    const topology = compileTopology(countingManifest({ seed: 3, agents: ['agent-a', 'agent-b'] }))
    const world = new ArenaWorld(topology)
    const game = new CountingGame({ world, roomAlias: 'counting-room', target: 3 })
    const subject = scaffoldSubject(topology)
    try {
      const runner = new CollaborationGameRunner({
        root: subject.root,
        world: game,
        artifactDir: join(scratch(), 'failing'),
        game: 'same-room-counting',
        seed: 3,
        mode: 'deterministic',
        subjectKind: 'scripted',
        hostFactory: ((agent: { id: string }) => ({
          start: async () => {},
          newSession: async () => `failing-${agent.id.slice(0, 8)}`,
          hasSession: () => true,
          modelOptions: () => ({ current: 'failing', models: ['failing'] }),
          prompt: async () => {
            throw new Error('model unreachable')
          },
          cancel: async () => {},
          stop: async () => {}
        })) as never,
        capabilityProfile: { memory: 'off' },
        limits: { maxSteps: 6, timeoutMs: 60_000 },
        agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias }))
      })
      const result = await runner.run()
      expect(result.status).toBe('infra_error')
      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('TURN_FAILURES')
      expect(result.verdict.outcome).toMatchObject({ completed: false })
    } finally {
      subject.cleanup()
    }
  }, 120_000)

  it('is environment-deterministic (§8.1): same seed, same world, same reproducible outcome', async () => {
    const first = await runSameRoomCounting({
      seed: 7,
      target: 5,
      artifactDir: join(scratch(), 'a'),
      timeoutMs: 90_000
    })
    const second = await runSameRoomCounting({
      seed: 7,
      target: 5,
      artifactDir: join(scratch(), 'b'),
      timeoutMs: 90_000
    })
    expect(first.status).toBe('passed')
    expect(second.status).toBe('passed')
    // The scripted-host OUTCOME is reproducible. WITHIN a wave the arrival
    // order of concurrent turns follows runtime scheduling ("first valid
    // arrival wins", §8.1), so per-number scorer identity is explainable via
    // the recorded sequence log rather than guaranteed identical.
    for (const result of [first, second]) {
      expect(result.verdict.outcome).toMatchObject({ completed: true, acceptedPrefix: 5, target: 5 })
      expect(result.verdict.refereeConsistent).toBe(true)
    }
    // Environment determinism: identical compiled topologies for equal seeds.
    const topologyA = JSON.parse(readFileSync(first.paths.topology, 'utf8'))
    const topologyB = JSON.parse(readFileSync(second.paths.topology, 'utf8'))
    expect(topologyA).toEqual(topologyB)
  }, 180_000)
})
